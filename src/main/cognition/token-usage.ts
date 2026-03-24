import { reportTokenUsage } from "@main/services/token/token-usage-reporter";

export function reportCognitionTokenUsage(input: {
  usage?: unknown;
  inputText?: string;
  outputText?: string;
  systemText?: string;
}): void {
  reportTokenUsage({
    source: "background:cognition",
    usage: input.usage,
    inputText: input.inputText,
    outputText: input.outputText,
    systemText: input.systemText
  });
}
