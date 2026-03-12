import { ConsoleChatPane } from "@renderer/pages/console-chat/ConsoleChatPane";
import { useConsoleChatController } from "@renderer/pages/console-chat/useConsoleChatController";

export function ConsoleChatPage() {
  const {
    messages,
    draft,
    setDraft,
    sttReady,
    micHint,
    pendingApproval,
    skillsCatalog,
    activatedSkills,
    approvalIndex,
    setApprovalIndex,
    historyLoaded,
    historyHasMore,
    loadingMoreHistory,
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
    stoppingRequest,
    chatBottomRef,
    chatListRef,
    inputRef,
    clearHistory,
    handleChatScroll,
    handleSubmit,
    stopCurrentRequest,
    handleInputKeyDown,
    toggleMicRecording,
    submitApproval
  } = useConsoleChatController();

  return (
    <div className="h-[calc(100vh-140px)] min-h-[680px] max-h-[900px]">
      <ConsoleChatPane
        busy={busy}
        clearingHistory={clearingHistory}
        historyLoaded={historyLoaded}
        historyHasMore={historyHasMore}
        loadingMoreHistory={loadingMoreHistory}
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
        inputRef={inputRef}
        inputDisabled={inputDisabled}
        onInputKeyDown={handleInputKeyDown}
        toggleMicRecording={toggleMicRecording}
        micButtonDisabled={micButtonDisabled}
        recording={recording}
        transcribing={transcribing}
        micButtonLabel={micButtonLabel}
        stoppingRequest={stoppingRequest}
        sttReady={sttReady}
        micHint={micHint}
        onSubmit={handleSubmit}
        stopCurrentRequest={stopCurrentRequest}
        clearHistory={clearHistory}
      />
    </div>
  );
}
