use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use aec_rs::{Aec, AecConfig};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use serde::{Deserialize, Serialize};

const OUTPUT_SAMPLE_RATE: u32 = 16_000;
const STREAM_CHUNK_SAMPLES: usize = 320;
const AEC_FILTER_LENGTH: i32 = 4_800;
const AEC_PLAYOUT_DELAY_MS: u64 = 80;
const REFERENCE_MATCH_MAX_DELTA_MS: u64 = 80;
const REFERENCE_FRAME_RETENTION_MS: u64 = 500;
const AEC_ENABLE_PREPROCESS: bool = true;

#[derive(Debug, Deserialize)]
struct RawCommand {
    command: String,
    #[serde(rename = "pcm16Base64")]
    pcm16_base64: Option<String>,
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
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
    PushReferenceFrame {
        samples: Vec<i16>,
        sample_rate: u32,
    },
    ClearReference,
    Shutdown,
}

#[derive(Debug)]
enum EngineMessage {
    Command(HelperCommand),
    Samples {
        samples: Vec<f32>,
        captured_at: Instant,
    },
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

trait EchoCancellerBackend {
    fn cancel_echo(&mut self, rec_buffer: &[i16], echo_buffer: &[i16], out_buffer: &mut [i16]);
    fn reset(&mut self);
}

struct SpeexEchoCanceller {
    config: AecConfig,
    inner: Aec,
}

impl SpeexEchoCanceller {
    fn new() -> Self {
        let config = AecConfig {
            frame_size: STREAM_CHUNK_SAMPLES,
            filter_length: AEC_FILTER_LENGTH,
            sample_rate: OUTPUT_SAMPLE_RATE,
            enable_preprocess: AEC_ENABLE_PREPROCESS,
        };
        let inner = Aec::new(&config);
        Self { config, inner }
    }
}

impl EchoCancellerBackend for SpeexEchoCanceller {
    fn cancel_echo(&mut self, rec_buffer: &[i16], echo_buffer: &[i16], out_buffer: &mut [i16]) {
        self.inner.cancel_echo(rec_buffer, echo_buffer, out_buffer);
    }

    fn reset(&mut self) {
        self.inner = Aec::new(&self.config);
    }
}

struct ReferenceFrame {
    samples: Vec<i16>,
    received_at: Instant,
}

struct ReferenceFrameQueue {
    frames: VecDeque<ReferenceFrame>,
}

impl ReferenceFrameQueue {
    fn new() -> Self {
        Self {
            frames: VecDeque::new(),
        }
    }

    fn push(&mut self, samples: Vec<i16>, received_at: Instant) {
        self.frames.push_back(ReferenceFrame {
            samples,
            received_at,
        });
        self.prune_retained(received_at);
    }

    fn clear(&mut self) {
        self.frames.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.frames.len()
    }

    fn take_best_match(&mut self, captured_at: Instant) -> Option<Vec<i16>> {
        self.prune_retained(captured_at);

        let max_delta = Duration::from_millis(REFERENCE_MATCH_MAX_DELTA_MS);
        let mut best_index: Option<usize> = None;
        let mut best_delta = Duration::MAX;

        for (index, frame) in self.frames.iter().enumerate() {
            let delta = instant_delta(captured_at, frame.received_at);
            if delta <= max_delta && delta < best_delta {
                best_index = Some(index);
                best_delta = delta;
            }
        }

        if let Some(index) = best_index {
            for _ in 0..index {
                self.frames.pop_front();
            }
            return self.frames.pop_front().map(|frame| frame.samples);
        }

        self.prune_stale(captured_at);
        None
    }

    fn prune_retained(&mut self, now: Instant) {
        let max_age = Duration::from_millis(REFERENCE_FRAME_RETENTION_MS);
        while self
            .frames
            .front()
            .map(|frame| now.saturating_duration_since(frame.received_at) > max_age)
            .unwrap_or(false)
        {
            self.frames.pop_front();
        }
    }

    fn prune_stale(&mut self, captured_at: Instant) {
        let max_delta = Duration::from_millis(REFERENCE_MATCH_MAX_DELTA_MS);
        while self
            .frames
            .front()
            .map(|frame| captured_at.saturating_duration_since(frame.received_at) > max_delta)
            .unwrap_or(false)
        {
            self.frames.pop_front();
        }
    }
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
    echo_canceller: Box<dyn EchoCancellerBackend>,
    reference_frames: ReferenceFrameQueue,
}

impl AudioEngine {
    fn new() -> Self {
        Self {
            stream: None,
            downsampler: None,
            mode: CaptureMode::Idle,
            segment_samples: Vec::new(),
            stream_samples: Vec::new(),
            echo_canceller: Box::new(SpeexEchoCanceller::new()),
            reference_frames: ReferenceFrameQueue::new(),
        }
    }

    #[cfg(test)]
    fn with_echo_canceller(echo_canceller: Box<dyn EchoCancellerBackend>) -> Self {
        Self {
            stream: None,
            downsampler: None,
            mode: CaptureMode::Idle,
            segment_samples: Vec::new(),
            stream_samples: Vec::new(),
            echo_canceller,
            reference_frames: ReferenceFrameQueue::new(),
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
        self.reset_aec();
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
        self.reset_aec();
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
        self.reset_aec();
        self.mode = CaptureMode::Stream;
        self.stream_samples.clear();
        self.segment_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
        Ok(())
    }

    fn stop_stream(&mut self) {
        self.reset_aec();
        self.mode = CaptureMode::Idle;
        self.stream_samples.clear();
        if let Some(downsampler) = self.downsampler.as_mut() {
            downsampler.reset();
        }
    }

    fn push_reference_frame_samples(&mut self, samples: Vec<i16>, sample_rate: u32) {
        if sample_rate != OUTPUT_SAMPLE_RATE || samples.len() != STREAM_CHUNK_SAMPLES {
            return;
        }

        self.reference_frames.push(samples, Instant::now());
    }

    #[cfg(test)]
    fn reference_frame_count(&self) -> usize {
        self.reference_frames.len()
    }

    fn process_stream_frame(&mut self, mic_frame: &[i16], captured_at: Instant) -> Vec<i16> {
        let Some(reference_frame) = self
            .reference_frames
            .take_best_match(reference_target_instant(captured_at))
        else {
            return mic_frame.to_vec();
        };

        if reference_frame.len() != mic_frame.len() {
            return mic_frame.to_vec();
        }

        let mut output = vec![0i16; mic_frame.len()];
        self.echo_canceller
            .cancel_echo(mic_frame, &reference_frame, &mut output);
        output
    }

    fn clear_reference_frames(&mut self) {
        self.reference_frames.clear();
    }

    fn reset_aec(&mut self) {
        self.clear_reference_frames();
        self.echo_canceller.reset();
    }

    fn process_samples(&mut self, samples: Vec<f32>, captured_at: Instant) -> Vec<HelperEvent> {
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
                    let processed = self.process_stream_frame(&chunk, captured_at);
                    events.push(HelperEvent::PcmFrame {
                        pcm16_base64: encode_i16_samples(&processed),
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
        self.reset_aec();
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

fn reference_target_instant(captured_at: Instant) -> Instant {
    captured_at
        .checked_sub(Duration::from_millis(AEC_PLAYOUT_DELAY_MS))
        .unwrap_or(captured_at)
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
                HelperCommand::PushReferenceFrame {
                    samples,
                    sample_rate,
                } => {
                    engine.push_reference_frame_samples(samples, sample_rate);
                }
                HelperCommand::ClearReference => {
                    engine.clear_reference_frames();
                }
                HelperCommand::Shutdown => {
                    engine.shutdown();
                    break;
                }
            },
            EngineMessage::Samples {
                samples,
                captured_at,
            } => {
                for event in engine.process_samples(samples, captured_at) {
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
        "push_reference_frame" => {
            let sample_rate = parsed
                .sample_rate
                .ok_or_else(|| "missing sampleRate for push_reference_frame".to_string())?;
            let encoded = parsed
                .pcm16_base64
                .as_deref()
                .ok_or_else(|| "missing pcm16Base64 for push_reference_frame".to_string())?;
            let bytes = BASE64
                .decode(encoded)
                .map_err(|error| format!("invalid base64 reference audio: {error}"))?;
            let samples = decode_i16_samples(&bytes)?;
            Ok(HelperCommand::PushReferenceFrame {
                samples,
                sample_rate,
            })
        }
        "clear_reference" => Ok(HelperCommand::ClearReference),
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
                        let _ = sample_sender.send(EngineMessage::Samples {
                            samples: mono,
                            captured_at: Instant::now(),
                        });
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
                        let _ = sample_sender.send(EngineMessage::Samples {
                            samples: mono,
                            captured_at: Instant::now(),
                        });
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
                        let _ = sample_sender.send(EngineMessage::Samples {
                            samples: mono,
                            captured_at: Instant::now(),
                        });
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

fn decode_i16_samples(bytes: &[u8]) -> Result<Vec<i16>, String> {
    if bytes.len() % 2 != 0 {
        return Err("pcm16 payload must contain an even number of bytes".to_string());
    }

    Ok(bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect())
}

fn instant_delta(left: Instant, right: Instant) -> Duration {
    if left >= right {
        left.duration_since(right)
    } else {
        right.duration_since(left)
    }
}

fn float_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped < 0.0 {
        (clamped * 32_768.0).round() as i16
    } else {
        (clamped * 32_767.0).round() as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    #[derive(Clone, Default)]
    struct FakeEchoCancellerState {
        cancel_calls: Vec<(Vec<i16>, Vec<i16>)>,
        reset_calls: usize,
        next_output: Option<Vec<i16>>,
    }

    struct FakeEchoCanceller {
        state: Rc<RefCell<FakeEchoCancellerState>>,
    }

    impl FakeEchoCanceller {
        fn new(state: Rc<RefCell<FakeEchoCancellerState>>) -> Self {
            Self { state }
        }
    }

    impl EchoCancellerBackend for FakeEchoCanceller {
        fn cancel_echo(&mut self, rec_buffer: &[i16], echo_buffer: &[i16], out_buffer: &mut [i16]) {
            let mut state = self.state.borrow_mut();
            state
                .cancel_calls
                .push((rec_buffer.to_vec(), echo_buffer.to_vec()));
            if let Some(next_output) = state.next_output.take() {
                out_buffer.copy_from_slice(&next_output);
                return;
            }

            out_buffer.copy_from_slice(rec_buffer);
        }

        fn reset(&mut self) {
            self.state.borrow_mut().reset_calls += 1;
        }
    }

    #[test]
    fn parse_command_supports_reference_commands() {
        let push_command = parse_command(
            r#"{"command":"push_reference_frame","pcm16Base64":"AQIDBA==","sampleRate":16000}"#,
        )
        .expect("push_reference_frame should parse");
        match push_command {
            HelperCommand::PushReferenceFrame { sample_rate, .. } => {
                assert_eq!(sample_rate, 16_000);
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let clear_command =
            parse_command(r#"{"command":"clear_reference"}"#).expect("clear_reference should parse");
        assert!(matches!(clear_command, HelperCommand::ClearReference));
    }

    #[test]
    fn speex_echo_canceller_uses_tuned_desktop_defaults() {
        let canceller = SpeexEchoCanceller::new();

        assert_eq!(canceller.config.filter_length, 4_800);
        assert!(canceller.config.enable_preprocess);
    }

    #[test]
    fn reference_frame_queue_selects_the_nearest_frame() {
        let mut queue = ReferenceFrameQueue::new();
        let base = std::time::Instant::now();

        queue.push(vec![1; STREAM_CHUNK_SAMPLES], base);
        queue.push(vec![2; STREAM_CHUNK_SAMPLES], base + Duration::from_millis(20));
        queue.push(vec![3; STREAM_CHUNK_SAMPLES], base + Duration::from_millis(40));

        let matched = queue
            .take_best_match(base + Duration::from_millis(19))
            .expect("expected a nearby reference frame");

        assert_eq!(matched, vec![2; STREAM_CHUNK_SAMPLES]);
    }

    #[test]
    fn reference_frame_queue_accepts_matches_within_80ms_window() {
        let mut queue = ReferenceFrameQueue::new();
        let base = std::time::Instant::now();
        queue.push(vec![8; STREAM_CHUNK_SAMPLES], base);

        let matched = queue
            .take_best_match(base + Duration::from_millis(75))
            .expect("expected reference frame to remain matchable inside the widened window");

        assert_eq!(matched, vec![8; STREAM_CHUNK_SAMPLES]);
    }

    #[test]
    fn reference_frame_queue_prunes_stale_unmatched_frames() {
        let mut queue = ReferenceFrameQueue::new();
        let base = std::time::Instant::now();
        queue.push(vec![7; STREAM_CHUNK_SAMPLES], base);

        let matched = queue.take_best_match(base + Duration::from_millis(120));

        assert!(matched.is_none());
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn audio_engine_stream_frame_falls_back_to_original_pcm_without_reference() {
        let state = Rc::new(RefCell::new(FakeEchoCancellerState {
            next_output: Some(vec![9; STREAM_CHUNK_SAMPLES]),
            ..FakeEchoCancellerState::default()
        }));
        let mut engine =
            AudioEngine::with_echo_canceller(Box::new(FakeEchoCanceller::new(state.clone())));
        engine.mode = CaptureMode::Stream;
        let mic = vec![5; STREAM_CHUNK_SAMPLES];

        let output = engine.process_stream_frame(&mic, std::time::Instant::now());

        assert_eq!(output, mic);
        assert_eq!(state.borrow().cancel_calls.len(), 0);
    }

    #[test]
    fn audio_engine_stream_frame_uses_echo_canceller_when_reference_is_available() {
        let state = Rc::new(RefCell::new(FakeEchoCancellerState {
            next_output: Some(vec![9; STREAM_CHUNK_SAMPLES]),
            ..FakeEchoCancellerState::default()
        }));
        let mut engine =
            AudioEngine::with_echo_canceller(Box::new(FakeEchoCanceller::new(state.clone())));
        engine.mode = CaptureMode::Stream;
        engine.push_reference_frame_samples(vec![3; STREAM_CHUNK_SAMPLES], OUTPUT_SAMPLE_RATE);
        let mic = vec![5; STREAM_CHUNK_SAMPLES];

        let output = engine.process_stream_frame(&mic, std::time::Instant::now());

        assert_eq!(output, vec![9; STREAM_CHUNK_SAMPLES]);
        assert_eq!(state.borrow().cancel_calls.len(), 1);
    }

    #[test]
    fn audio_engine_stream_frame_applies_playout_delay_compensation_before_matching_reference() {
        let state = Rc::new(RefCell::new(FakeEchoCancellerState {
            next_output: Some(vec![9; STREAM_CHUNK_SAMPLES]),
            ..FakeEchoCancellerState::default()
        }));
        let mut engine =
            AudioEngine::with_echo_canceller(Box::new(FakeEchoCanceller::new(state.clone())));
        let base = std::time::Instant::now();
        engine.mode = CaptureMode::Stream;
        engine
            .reference_frames
            .push(vec![1; STREAM_CHUNK_SAMPLES], base + Duration::from_millis(100));
        engine
            .reference_frames
            .push(vec![2; STREAM_CHUNK_SAMPLES], base + Duration::from_millis(140));
        let mic = vec![5; STREAM_CHUNK_SAMPLES];

        let output = engine.process_stream_frame(&mic, base + Duration::from_millis(180));

        assert_eq!(output, vec![9; STREAM_CHUNK_SAMPLES]);
        assert_eq!(state.borrow().cancel_calls.len(), 1);
        assert_eq!(
            state.borrow().cancel_calls[0].1,
            vec![1; STREAM_CHUNK_SAMPLES]
        );
    }

    #[test]
    fn audio_engine_stop_stream_clears_reference_queue_and_resets_aec() {
        let state = Rc::new(RefCell::new(FakeEchoCancellerState::default()));
        let mut engine =
            AudioEngine::with_echo_canceller(Box::new(FakeEchoCanceller::new(state.clone())));
        engine.mode = CaptureMode::Stream;
        engine.push_reference_frame_samples(vec![1; STREAM_CHUNK_SAMPLES], OUTPUT_SAMPLE_RATE);

        engine.stop_stream();

        assert_eq!(engine.reference_frame_count(), 0);
        assert_eq!(state.borrow().reset_calls, 1);
    }

    #[test]
    fn audio_engine_ignores_reference_frames_with_unsupported_sample_rate() {
        let state = Rc::new(RefCell::new(FakeEchoCancellerState::default()));
        let mut engine =
            AudioEngine::with_echo_canceller(Box::new(FakeEchoCanceller::new(state)));

        engine.push_reference_frame_samples(vec![1; STREAM_CHUNK_SAMPLES], 8_000);

        assert_eq!(engine.reference_frame_count(), 0);
    }
}
