use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use serde::{Deserialize, Serialize};

const OUTPUT_SAMPLE_RATE: u32 = 16_000;
const STREAM_CHUNK_SAMPLES: usize = 320;

#[derive(Debug, Deserialize)]
struct RawCommand {
    command: String,
}

#[derive(Debug)]
enum HelperCommand {
    EnsureOpen,
    Close,
    StartSegment,
    StopSegment,
    CancelSegment,
    StartStream,
    StopStream,
    Shutdown,
}

#[derive(Debug)]
enum EngineMessage {
    Command(HelperCommand),
    Samples(Vec<f32>),
    Error(String),
    StdinClosed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureMode {
    Idle,
    Segment,
    Stream,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperEvent {
    Ready,
    Opened,
    PcmFrame {
        #[serde(rename = "pcm16Base64")]
        pcm16_base64: String,
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
    },
    SegmentResult {
        #[serde(rename = "pcm16Base64")]
        pcm16_base64: String,
        #[serde(rename = "durationMs")]
        duration_ms: u32,
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
    },
    Error {
        message: String,
    },
    Closed,
}

struct Downsampler {
    input_rate: u32,
    output_rate: u32,
    pending: Vec<f32>,
    consumed_input_samples: usize,
    emitted_output_samples: usize,
}

impl Downsampler {
    fn new(input_rate: u32, output_rate: u32) -> Result<Self, String> {
        if input_rate < output_rate {
            return Err(format!(
                "unsupported input sample rate {input_rate}Hz; expected at least {output_rate}Hz"
            ));
        }

        Ok(Self {
            input_rate,
            output_rate,
            pending: Vec::new(),
            consumed_input_samples: 0,
            emitted_output_samples: 0,
        })
    }

    fn reset(&mut self) {
        self.pending.clear();
        self.consumed_input_samples = 0;
        self.emitted_output_samples = 0;
    }

    fn process_chunk(&mut self, input: &[f32]) -> Vec<i16> {
        if input.is_empty() {
            return Vec::new();
        }

        if self.input_rate == self.output_rate {
            return input.iter().copied().map(float_to_i16).collect();
        }

        self.pending.extend_from_slice(input);
        let ratio = self.input_rate as f64 / self.output_rate as f64;
        let mut output = Vec::new();

        loop {
            let boundary_abs = (((self.emitted_output_samples + 1) as f64) * ratio).floor() as usize;
            let window_len = boundary_abs.saturating_sub(self.consumed_input_samples);
            if window_len == 0 || window_len > self.pending.len() {
                break;
            }

            let window = &self.pending[..window_len];
            let average = if window.is_empty() {
                0.0
            } else {
                window.iter().copied().sum::<f32>() / window.len() as f32
            };
            output.push(float_to_i16(average));
            self.pending.drain(..window_len);
            self.consumed_input_samples = boundary_abs;
            self.emitted_output_samples += 1;
        }

        output
    }
}

struct AudioEngine {
    stream: Option<Stream>,
    downsampler: Option<Downsampler>,
    mode: CaptureMode,
    segment_samples: Vec<i16>,
    stream_samples: Vec<i16>,
}

impl AudioEngine {
    fn new() -> Self {
        Self {
            stream: None,
            downsampler: None,
            mode: CaptureMode::Idle,
            segment_samples: Vec::new(),
            stream_samples: Vec::new(),
        }
    }

    fn ensure_open(&mut self, sender: &Sender<EngineMessage>) -> Result<(), String> {
        if self.stream.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no default input device available".to_string())?;
        let supported_config = select_input_config(&device)?;
        let sample_format = supported_config.sample_format();
        let input_rate = supported_config.sample_rate();
        let config: StreamConfig = supported_config.into();
        let stream = build_input_stream(&device, &config, sample_format, sender.clone())?;
        stream.play().map_err(|error| format!("failed to start input stream: {error}"))?;
        self.downsampler = Some(Downsampler::new(input_rate, OUTPUT_SAMPLE_RATE)?);
        self.stream = Some(stream);
        Ok(())
    }

    fn start_segment(&mut self) -> Result<(), String> {
        self.ensure_idle_transition()?;
        self.ensure_open_state()?;
        self.mode = CaptureMode::Segment;
        self.segment_samples.clear();
        self.stream_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
          downsampler.reset();
        }
        Ok(())
    }

    fn stop_segment(&mut self) -> Result<HelperEvent, String> {
        if self.mode != CaptureMode::Segment {
            return Err("segment recording is not active".to_string());
        }

        self.mode = CaptureMode::Idle;
        let pcm16_base64 = encode_i16_samples(&self.segment_samples);
        let duration_ms = ((self.segment_samples.len() as f64 / OUTPUT_SAMPLE_RATE as f64) * 1000.0).round() as u32;
        self.segment_samples.clear();

        Ok(HelperEvent::SegmentResult {
            pcm16_base64,
            duration_ms,
            sample_rate: OUTPUT_SAMPLE_RATE,
        })
    }

    fn cancel_segment(&mut self) {
        self.mode = CaptureMode::Idle;
        self.segment_samples.clear();
        self.stream_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
    }

    fn start_stream(&mut self) -> Result<(), String> {
        self.ensure_idle_transition()?;
        self.ensure_open_state()?;
        self.mode = CaptureMode::Stream;
        self.stream_samples.clear();
        self.segment_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
        Ok(())
    }

    fn stop_stream(&mut self) {
        self.mode = CaptureMode::Idle;
        self.stream_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
    }

    fn process_samples(&mut self, samples: Vec<f32>) -> Vec<HelperEvent> {
        if self.mode == CaptureMode::Idle {
            return Vec::new();
        }

        let Some(downsampler) = self.downsampler.as_mut() else {
            return Vec::new();
        };

        let converted = downsampler.process_chunk(&samples);
        if converted.is_empty() {
            return Vec::new();
        }

        match self.mode {
            CaptureMode::Idle => Vec::new(),
            CaptureMode::Segment => {
                self.segment_samples.extend(converted);
                Vec::new()
            }
            CaptureMode::Stream => {
                self.stream_samples.extend(converted);
                let mut events = Vec::new();
                while self.stream_samples.len() >= STREAM_CHUNK_SAMPLES {
                    let chunk: Vec<i16> = self.stream_samples.drain(..STREAM_CHUNK_SAMPLES).collect();
                    events.push(HelperEvent::PcmFrame {
                        pcm16_base64: encode_i16_samples(&chunk),
                        sample_rate: OUTPUT_SAMPLE_RATE,
                    });
                }
                events
            }
        }
    }

    fn shutdown(&mut self) {
        self.close();
    }

    fn close(&mut self) {
        self.mode = CaptureMode::Idle;
        self.segment_samples.clear();
        self.stream_samples.clear();
        self.downsampler = None;
        self.stream = None;
    }

    fn ensure_idle_transition(&self) -> Result<(), String> {
        if self.mode == CaptureMode::Idle {
            return Ok(());
        }

        Err("audio capture is already active".to_string())
    }

    fn ensure_open_state(&self) -> Result<(), String> {
        if self.stream.is_some() && self.downsampler.is_some() {
            return Ok(());
        }

        Err("audio capture is not open".to_string())
    }
}

fn main() {
    let (sender, receiver) = mpsc::channel::<EngineMessage>();
    let stdin_sender = sender.clone();
    thread::spawn(move || {
        read_stdin(stdin_sender);
    });

    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut engine = AudioEngine::new();
    let _ = emit_event(&mut writer, HelperEvent::Ready);

    run_event_loop(&mut engine, &receiver, &sender, &mut writer);
}

fn run_event_loop(
    engine: &mut AudioEngine,
    receiver: &Receiver<EngineMessage>,
    sender: &Sender<EngineMessage>,
    writer: &mut dyn Write,
) {
    while let Ok(message) = receiver.recv() {
        match message {
            EngineMessage::Command(command) => match command {
                HelperCommand::EnsureOpen => match engine.ensure_open(sender) {
                    Ok(()) => {
                        let _ = emit_event(writer, HelperEvent::Opened);
                    }
                    Err(message) => {
                        let _ = emit_event(writer, HelperEvent::Error { message });
                    }
                },
                HelperCommand::Close => {
                    engine.close();
                    let _ = emit_event(writer, HelperEvent::Closed);
                }
                HelperCommand::StartSegment => {
                    if let Err(message) = engine.start_segment() {
                        let _ = emit_event(writer, HelperEvent::Error { message });
                    }
                }
                HelperCommand::StopSegment => match engine.stop_segment() {
                    Ok(event) => {
                        let _ = emit_event(writer, event);
                    }
                    Err(message) => {
                        let _ = emit_event(writer, HelperEvent::Error { message });
                    }
                },
                HelperCommand::CancelSegment => {
                    engine.cancel_segment();
                }
                HelperCommand::StartStream => {
                    if let Err(message) = engine.start_stream() {
                        let _ = emit_event(writer, HelperEvent::Error { message });
                    }
                }
                HelperCommand::StopStream => {
                    engine.stop_stream();
                }
                HelperCommand::Shutdown => {
                    engine.shutdown();
                    break;
                }
            },
            EngineMessage::Samples(samples) => {
                for event in engine.process_samples(samples) {
                    let _ = emit_event(writer, event);
                }
            }
            EngineMessage::Error(message) => {
                let _ = emit_event(writer, HelperEvent::Error { message });
            }
            EngineMessage::StdinClosed => {
                engine.shutdown();
                break;
            }
        }
    }
}

fn read_stdin(sender: Sender<EngineMessage>) {
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    for line in reader.lines() {
        match line {
            Ok(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match parse_command(trimmed) {
                    Ok(command) => {
                        let _ = sender.send(EngineMessage::Command(command));
                    }
                    Err(message) => {
                        let _ = sender.send(EngineMessage::Error(message));
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(EngineMessage::Error(format!("failed to read stdin: {error}")));
                let _ = sender.send(EngineMessage::StdinClosed);
                return;
            }
        }
    }

    let _ = sender.send(EngineMessage::StdinClosed);
}

fn parse_command(raw: &str) -> Result<HelperCommand, String> {
    let parsed: RawCommand =
        serde_json::from_str(raw).map_err(|error| format!("invalid command JSON: {error}"))?;
    match parsed.command.as_str() {
        "ensure_open" => Ok(HelperCommand::EnsureOpen),
        "close" => Ok(HelperCommand::Close),
        "start_segment" => Ok(HelperCommand::StartSegment),
        "stop_segment" => Ok(HelperCommand::StopSegment),
        "cancel_segment" => Ok(HelperCommand::CancelSegment),
        "start_stream" => Ok(HelperCommand::StartStream),
        "stop_stream" => Ok(HelperCommand::StopStream),
        "shutdown" => Ok(HelperCommand::Shutdown),
        other => Err(format!("unsupported command: {other}")),
    }
}

fn emit_event(writer: &mut dyn Write, event: HelperEvent) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, &event)
        .map_err(|error| format!("failed to encode event: {error}"))?;
    writer
        .write_all(b"\n")
        .map_err(|error| format!("failed to write event: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush event: {error}"))
}

fn select_input_config(device: &Device) -> Result<SupportedStreamConfig, String> {
    let mut ranges: Vec<_> = device
        .supported_input_configs()
        .map_err(|error| format!("failed to query input configs: {error}"))?
        .collect();
    ranges.sort_by_key(|range| (format_rank(range.sample_format()), range.channels()));

    if let Some(config) = ranges
        .iter()
        .find_map(|range| range.try_with_sample_rate(OUTPUT_SAMPLE_RATE))
    {
        return Ok(config);
    }

    let default = device
        .default_input_config()
        .map_err(|error| format!("failed to read default input config: {error}"))?;
    if default.sample_rate() < OUTPUT_SAMPLE_RATE {
        return Err(format!(
            "default input sample rate {}Hz is lower than required {}Hz",
            default.sample_rate(),
            OUTPUT_SAMPLE_RATE
        ));
    }

    Ok(default)
}

fn format_rank(format: SampleFormat) -> usize {
    match format {
        SampleFormat::I16 => 0,
        SampleFormat::F32 => 1,
        SampleFormat::U16 => 2,
        _ => 10,
    }
}

fn build_input_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    sender: Sender<EngineMessage>,
) -> Result<Stream, String> {
    let channels = config.channels as usize;
    match sample_format {
        SampleFormat::F32 => {
            let sample_sender = sender.clone();
            let error_sender = sender.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32(data, channels);
                        let _ = sample_sender.send(EngineMessage::Samples(mono));
                    },
                    move |error| {
                        let _ = error_sender.send(EngineMessage::Error(error.to_string()));
                    },
                    None,
                )
                .map_err(|error| format!("failed to build input stream: {error}"))
        }
        SampleFormat::I16 => {
            let sample_sender = sender.clone();
            let error_sender = sender.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        let mono = downmix_i16(data, channels);
                        let _ = sample_sender.send(EngineMessage::Samples(mono));
                    },
                    move |error| {
                        let _ = error_sender.send(EngineMessage::Error(error.to_string()));
                    },
                    None,
                )
                .map_err(|error| format!("failed to build input stream: {error}"))
        }
        SampleFormat::U16 => {
            let sample_sender = sender.clone();
            let error_sender = sender.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        let mono = downmix_u16(data, channels);
                        let _ = sample_sender.send(EngineMessage::Samples(mono));
                    },
                    move |error| {
                        let _ = error_sender.send(EngineMessage::Error(error.to_string()));
                    },
                    None,
                )
                .map_err(|error| format!("failed to build input stream: {error}"))
        }
        other => Err(format!("unsupported sample format: {other}")),
    }
}

fn downmix_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }

    data.chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data
            .iter()
            .copied()
            .map(|sample| sample as f32 / i16::MAX as f32)
            .collect();
    }

    data.chunks(channels)
        .map(|frame| {
            frame
                .iter()
                .copied()
                .map(|sample| sample as f32 / i16::MAX as f32)
                .sum::<f32>()
                / frame.len() as f32
        })
        .collect()
}

fn downmix_u16(data: &[u16], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data
            .iter()
            .copied()
            .map(|sample| (sample as f32 - 32_768.0) / 32_768.0)
            .collect();
    }

    data.chunks(channels)
        .map(|frame| {
            frame
                .iter()
                .copied()
                .map(|sample| (sample as f32 - 32_768.0) / 32_768.0)
                .sum::<f32>()
                / frame.len() as f32
        })
        .collect()
}

fn encode_i16_samples(samples: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    BASE64.encode(bytes)
}

fn float_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped < 0.0 {
        (clamped * 32_768.0).round() as i16
    } else {
        (clamped * 32_767.0).round() as i16
    }
}
