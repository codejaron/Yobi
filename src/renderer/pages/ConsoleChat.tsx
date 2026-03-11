import { ConsoleActionPane } from "@renderer/pages/console-chat/ConsoleActionPane";
import { ConsoleChatPane } from "@renderer/pages/console-chat/ConsoleChatPane";
import { useConsoleChatController } from "@renderer/pages/console-chat/useConsoleChatController";

export function ConsoleChatPage() {
  const {
    messages,
    actions,
    logEnabled,
    setLogEnabled,
    draft,
    setDraft,
    sttReady,
    micHint,
    pendingApproval,
    skillsCatalog,
    activatedSkills,
    approvalIndex,
    setApprovalIndex,
    expandedActions,
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
    chatBottomRef,
    chatListRef,
    actionBottomRef,
    inputRef,
    clearHistory,
    clearActionLogs,
    toggleActionExpanded,
    handleChatScroll,
    handleSubmit,
    handleInputKeyDown,
    toggleMicRecording,
    submitApproval,
    isToolAction
  } = useConsoleChatController();

  return (
    <div className="grid h-[calc(100vh-140px)] min-h-[680px] max-h-[900px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
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
        sttReady={sttReady}
        micHint={micHint}
        onSubmit={handleSubmit}
        clearHistory={clearHistory}
      />
      <ConsoleActionPane
        logEnabled={logEnabled}
        setLogEnabled={setLogEnabled}
        clearActionLogs={clearActionLogs}
        actions={actions}
        isToolAction={isToolAction}
        expandedActions={expandedActions}
        toggleActionExpanded={toggleActionExpanded}
        actionBottomRef={actionBottomRef}
      />
    </div>
  );
}
