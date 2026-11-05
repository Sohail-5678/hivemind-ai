// A2A-shaped records (lecture: Agent-to-Agent protocol). Every agent step is a
// Task with a lifecycle state; every output is a Message that references the
// teammates' tasks it was given. contextId groups everything in one room.

export const TASK_STATE = {
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
}

export function newTask({ id, contextId, agentId, title }) {
  return { id, contextId, agentId, title: String(title || '').slice(0, 160), status: { state: TASK_STATE.working } }
}

export function newMessage({ messageId, task, text, referenceTaskIds = [] }) {
  return {
    messageId,
    taskId: task.id,
    contextId: task.contextId,
    referenceTaskIds: [...new Set(referenceTaskIds.filter(Boolean))],
    role: 'agent',
    parts: [{ kind: 'text', text: String(text || '').slice(0, 300) + (String(text || '').length > 300 ? '…' : '') }],
  }
}

// Compact form stored in the timeline event's meta.
export function a2aMeta(task, message, state) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    messageId: message?.messageId || null,
    referenceTaskIds: message?.referenceTaskIds || [],
    state,
  }
}
