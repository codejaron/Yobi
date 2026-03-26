import { ConsoleChatPane } from "@renderer/pages/console-chat/ConsoleChatPane";
import { useConsoleChatController } from "@renderer/pages/console-chat/useConsoleChatController";

export function ConsoleChatPage() {
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
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
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
    submitApproval
  } = useConsoleChatController();

  return (
    <div className="h-full min-h-0">
      <ConsoleChatPane
        busy={busy}
        clearingHistory={clearingHistory}
        historyLoaded={historyLoaded}
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
        toggleMicRecording={toggleMicRecording}
        micButtonDisabled={micButtonDisabled}
        recording={recording}
        transcribing={transcribing}
        micButtonLabel={micButtonLabel}
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
