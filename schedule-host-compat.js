// Bridge the 0.2.1 session-bound Scheduler and 0.2.2 Host-wide management API.
// Do not retry writes: an ambiguous create outcome may already be durable.
export function toLegacyTask(task) {
  if (!task || task.sessionId !== undefined) return task;
  const sessionId = task.target?.kind === 'session' ? task.target.sessionId : undefined;
  return { ...task, ...(sessionId === undefined ? {} : { sessionId }) };
}

export function timingOf(request) {
  if (request.weekly) return { kind: 'weekly', weekly: request.weekly };
  if (request.daily) return { kind: 'daily', daily: request.daily };
  if (request.cron) return { kind: 'cron', cron: request.cron };
  if (request.at) return { kind: 'at', at: request.at };
  if (request.after_seconds !== undefined) return { kind: 'after', after_seconds: request.after_seconds };
  if (request.every_seconds !== undefined) return { kind: 'every', every_seconds: request.every_seconds };
  throw new Error('unsupported schedule recurrence: refusing to create a potentially duplicated task');
}

export function compatibleSchedule(schedule) {
  if (schedule && typeof schedule.update === 'function') return schedule; // 0.2.1
  if (!schedule || typeof schedule.edit !== 'function' || typeof schedule.catalog !== 'function') {
    throw new Error('unsupported Scheduler API: refusing automatic reminder migration');
  }
  const catalog = async () => (await schedule.catalog()).map(toLegacyTask);
  const owned = async (sessionId, id) => (await catalog()).find(task => task.id === id && task.sessionId === sessionId);
  return {
    get stopping() { return schedule.stopping; },
    catalog,
    async create(sessionId, request, signal) {
      const { title, prompt } = request;
      const created = await schedule.create({ title, prompt, timing: timingOf(request), target: { kind: 'session', sessionId } }, undefined, signal);
      if (typeof created?.id !== 'string') throw new Error('schedule create had an unconfirmed outcome; do not retry');
      return toLegacyTask(created);
    },
    async update(request, signal) {
      const current = await owned(request.sessionId, request.id);
      if (!current) return { code: 'schedule_not_found' };
      if (request.expected?.updatedAt && current.updatedAt !== request.expected.updatedAt) return { code: 'schedule_conflict' };
      const patch = { title: request.title, prompt: request.prompt };
      if (request.change) patch.timing = timingOf(request.change.kind === 'weekly' ? { weekly: request.change.weekly } : { daily: request.change.daily });
      const result = await schedule.edit({ id: request.id, action: 'update', patch,
        ...(current.updatedAt === undefined ? {} : { expectedUpdatedAt: current.updatedAt }) }, undefined, signal);
      if (result?.code) return { code: result.code };
      if (typeof result?.id !== 'string') throw new Error('schedule edit had an unconfirmed outcome; do not retry');
      return { record: toLegacyTask(result) };
    },
    async delete(request, signal) {
      if (!await owned(request.sessionId, request.id)) throw new Error('schedule delete refused: task ownership or existence changed');
      const result = await schedule.edit({ id: request.id, action: 'delete' }, undefined, signal);
      if (result?.deleted !== true) throw new Error('schedule delete unconfirmed: '+String(result?.code ?? 'unknown'));
      return result;
    },
    async history(request) {
      if (!await owned(request.sessionId, request.id)) return { id: request.id, code: 'schedule_not_found' };
      return schedule.history({ id: request.id, limit: request.limit, ...(request.before ? { before: request.before } : {}) });
    },
  };
}
