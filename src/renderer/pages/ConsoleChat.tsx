import type { AppConfig } from "@shared/types";
import { ConsoleChatPane } from "@renderer/pages/console-chat/ConsoleChatPane";
import { useConsoleChatController } from "@renderer/pages/console-chat/useConsoleChatController";

export function ConsoleChatPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const {
    messages,
    draft,
    setDraft,
    composerAttachments,
    micHint,
    taskMode,
    setTaskMode,
    pendingApproval,
    skillsCatalog,
    activatedSkills,
    approvalIndex,
    setApprovalIndex,
    historyLoaded,
    historyLoadingMore,
    historyLoadError,
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
    realtimeVoiceButtonDisabled,
    realtimeVoiceButtonLabel,
    realtimeVoiceButtonLoading,
    stoppingRequest,
    voiceSession,
    companionModeState,
    pendingVoiceContext,
    toggleVoiceSession,
    toggleCompanionMode,
    chatBottomRef,
    chatListRef,
    inputRef,
    clearHistory,
    handleChatScroll,
    handleSubmit,
    handleAttachmentSelection,
    removeComposerAttachment,
    stopCurrentRequest,
    handleInputKeyDown,
    handleInputPaste,
    handleComposerDrop,
    handleComposerDragOver,
    toggleMicRecording,
    submitApproval,
    slashMenuOpen,
    slashItems,
    slashSelectedIndex,
    setSlashSelectedIndex,
    executeSlashItem,
    slashFeedback
  } = useConsoleChatController({
    config,
    setConfig
  });

  return (
    <div className="h-full min-h-0">
      <ConsoleChatPane
        busy={busy}
        clearingHistory={clearingHistory}
        historyLoaded={historyLoaded}
        historyLoadingMore={historyLoadingMore}
        historyLoadError={historyLoadError}
        messages={messages}
        chatListRef={chatListRef}
        chatBottomRef={chatBottomRef}
        onChatScroll={handleChatScroll}
        pendingApproval={pendingApproval}
        skillsCatalog={skillsCatalog}
        activatedSkills={activatedSkills}
        approvalIndex={approvalIndex}
        setApprovalIndex={setApprovalIndex}
        submitApproval={submitApproval}
        draft={draft}
        setDraft={setDraft}
        composerAttachments={composerAttachments}
        inputRef={inputRef}
        inputDisabled={inputDisabled}
        onInputKeyDown={handleInputKeyDown}
        onInputPaste={handleInputPaste}
        onAttachmentSelection={handleAttachmentSelection}
        onRemoveAttachment={removeComposerAttachment}
        onComposerDrop={handleComposerDrop}
        onComposerDragOver={handleComposerDragOver}
        slashMenuOpen={slashMenuOpen}
        slashItems={slashItems}
        slashSelectedIndex={slashSelectedIndex}
        setSlashSelectedIndex={setSlashSelectedIndex}
        executeSlashItem={executeSlashItem}
        slashFeedback={slashFeedback}
        toggleMicRecording={toggleMicRecording}
        micButtonDisabled={micButtonDisabled}
        recording={recording}
        transcribing={transcribing}
        micButtonLabel={micButtonLabel}
        realtimeVoiceButtonDisabled={realtimeVoiceButtonDisabled}
        realtimeVoiceButtonLabel={realtimeVoiceButtonLabel}
        realtimeVoiceButtonLoading={realtimeVoiceButtonLoading}
        stoppingRequest={stoppingRequest}
        voiceSession={voiceSession}
        companionModeState={companionModeState}
        pendingVoiceContext={pendingVoiceContext}
        toggleVoiceSession={toggleVoiceSession}
        toggleCompanionMode={toggleCompanionMode}
        micHint={micHint}
        taskMode={taskMode}
        setTaskMode={setTaskMode}
        onSubmit={handleSubmit}
        stopCurrentRequest={stopCurrentRequest}
        clearHistory={clearHistory}
      />
    </div>
  );
}
