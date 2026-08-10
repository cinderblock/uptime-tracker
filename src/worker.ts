/**
 * Standalone deployment entry point — used when you deploy *this* repo directly.
 *
 * It exists separately from `index.ts` on purpose. `index.ts` is the library and
 * must never import `./config`, because a consumer that vendors this repo as a
 * git submodule cannot put a `config.ts` inside the submodule's working tree.
 * Keeping the only `./config` import here means importing `createWorker` costs
 * a consumer nothing.
 *
 * Consumers do the same three lines in their own repo, against their own config:
 *
 *   import { createWorker } from '../vendor/uptime-tracker/src/index';
 *   import { config, ddnsClients } from './config';
 *   export default createWorker({ config, ddnsClients });
 */
import { createWorker } from './index';
import { config, ddnsClients } from './config';

export default createWorker({ config, ddnsClients });
