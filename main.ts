// pumpfun-replay-sprint-01: a grind-rider bot for the agent-fun/replay/v2 pump.fun replay.
//
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/agentfun-bot.ts, vendored byte for byte.
//
// Idea (found by offline analysis of the kit's dev window): the launch pump is over within two
// slots, and our orders only fill two slots after the batch that decided them, so sniping launches
// buys the top. The coins that pay are the slow grinders: curves whose real SOL reserve keeps
// growing steadily over a hundred slots while the price holds near its high. We buy a small probe
// only once a curve is deep (real reserve >= 20 SOL) and still growing (>= 1.5x over the last
// 100 slots), then ride it with a wide take-profit and a tight stop. Most probes lose a little;
// the few that grind on to completion pay several times the stake.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
