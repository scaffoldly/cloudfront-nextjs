import { Action } from './action';
import { debug, setFailed } from '@actions/core';

(async () => {
  try {
    const action = new Action();
    await action.run();
  } catch (e) {
    if (e instanceof Error) {
      debug(`Error thrown: ${e}`);
      setFailed(e.message);
      return;
    }
    throw e;
  }
  process.exit(0);
})();
