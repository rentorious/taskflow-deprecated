// The one place that decides who may do what.
//
// An actor is { id, login, isInstanceAdmin, via, role }: `via` is "session" or
// "token", and `role` is that person's membership of THE PROJECT BEING ASKED ABOUT,
// or null. Whoever calls this has already looked that up; nothing here touches
// the database, so the whole policy can be read on one screen.
//
// A person with no role in a project is answered 404 by the caller, never 403: that
// a project exists is not theirs to learn. 403 is for members whose role falls short.

export const ACTIONS = Object.freeze({
  READ: 'project.read',              // a developer's cycle: lanes, plans, screenshots, questions
  WRITE_HUMAN: 'human.write',        // answer, mark sent, drop, tick
  MANAGE_MEMBERS: 'project.members', // invite, change a role, remove
  CREATE_PROJECT: 'project.create',
  MANAGE_TOKENS: 'tokens.manage',    // one's own CLI tokens
  SYNC_CYCLE: 'cycle.sync',          // push one's cycle, claim and release its batches, read their answers
  REQUEST_JOB: 'jobs.request',       // start, cancel and answer jobs from the page
  RUN_JOBS: 'jobs.run',              // a runner: register a machine, take jobs, report on them, ask
});

const SEES_THE_BOARD = new Set(['admin', 'developer']);

/**
 * @param {boolean} signInRequired  false only when the server runs on loopback with no sign-in
 *   configured: then whoever reaches it is the developer at their own machine.
 */
export function createAuthorizer({ signInRequired }) {
  /**
   * @param {object|null} actor
   * @param {string} action
   * @param {{ownsCycle?: boolean, developerSomewhere?: boolean}} [context]
   */
  return function authorize(actor, action, context = {}) {
    if (!signInRequired) {
      if (action === ACTIONS.READ) return true;
      // Nobody can be signed in. Only tests supply an actor, to exercise the write path.
      if (action === ACTIONS.WRITE_HUMAN) return Boolean(actor?.role);
      return false;
    }

    if (!actor) return false;
    switch (action) {
      case ACTIONS.READ:
        return SEES_THE_BOARD.has(actor.role);
      case ACTIONS.WRITE_HUMAN:
        // In the browser, on your own cycle. A teammate's cycle is read-only, and a CLI token never
        // records what a person said: an answer must come from someone looking at the question.
        return actor.via === 'session' && SEES_THE_BOARD.has(actor.role) && context.ownsCycle === true;
      case ACTIONS.SYNC_CYCLE:
        // The CLI's token or a browser session alike: both are that developer, and the cycle is always their own.
        return SEES_THE_BOARD.has(actor.role);
      case ACTIONS.REQUEST_JOB:
        // A person at the page. A job runs on that person's own machines, with that person's credentials.
        return actor.via === 'session' && SEES_THE_BOARD.has(actor.role);
      case ACTIONS.RUN_JOBS:
        // A machine, holding its owner's token. Never a browser: a page has no claude to run.
        return actor.via === 'token' && SEES_THE_BOARD.has(actor.role);
      case ACTIONS.MANAGE_MEMBERS:
        return actor.via === 'session' && (actor.role === 'admin' || actor.isInstanceAdmin === true);
      case ACTIONS.CREATE_PROJECT:
        return actor.via === 'session' && actor.isInstanceAdmin === true;
      case ACTIONS.MANAGE_TOKENS:
        // Answerers hold no token: a token exists to push and claim.
        return actor.via === 'session' && (actor.isInstanceAdmin === true || context.developerSomewhere === true);
      default:
        return false;
    }
  };
}
