import { Action } from './action';
import { debug, setFailed } from '@actions/core';
import PrettyError from 'pretty-error';
import { ErrorWithCause } from './error';

const pe = new PrettyError();

(async () => {
  try {
    const action = new Action();
    await action.run();
  } catch (e) {
    if (e instanceof ErrorWithCause) {
      if (e.cause && e.cause instanceof Error) {
        debug(`Caused by: ${pe.render(e.cause)}`);
        setFailed(`Error: ${e.message}, Caused by: ${e.cause.message}`);
      } else {
        debug(pe.render(e));
        setFailed(e.message);
      }
      process.exit(1);
    }
    throw e;
  }
  process.exit(0);
})();
