// Grind-rider strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Why this shape, from the dev window's own tape (1222 coins, 24h):
// - The launch pump is over within two slots of a coin's CreateEvent, and an order decided on a
//   batch only fills two slots later (latency_slots 2). Sniping a launch therefore buys the top:
//   every launch-sniper variant tested on the dev window loses money after fees.
// - 28 of the 35 curves that complete do so in the same slot they are created: untradeable, the
//   move is over before any order can fill. The other 7 grind up over 300-2200 slots, real SOL
//   reserve climbing steadily (13 -> 42 -> 62 -> 85 SOL) while the price holds near its high.
//   Those are the only multi-x payoffs a bot with a 2-slot latency can catch.
// - A pump-and-dump coin looks identical at birth but its reserve stalls or collapses within a
//   hundred slots, while a grinder's keeps growing. So entry waits: age >= minAge slots, real
//   reserve >= minRqSol, reserve up >= growth x over the last `lookback` slots, price within
//   `nearHigh` of the window high, several distinct buyers, positive net flow, creator not sold.
// - Stakes stay small (stakeSol, capped by the 1%-of-real-reserve per-batch order cap) and exits
//   are tight: a stop loss, a trailing stop armed once the position is up, and a wide take-profit
//   so a grinder that keeps climbing is ridden, not sold at the first pop. One entry per coin.
//
// Deterministic by construction: no clock, no randomness, no network, no model calls. All state
// is a pure function of the hello and batch messages the harness sends, iterated in
// insertion order, so the two graded executions produce byte-identical action logs.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Lookback window (slots) for the growth / high / flow checks. */
  lookback: number;
  /** Real SOL reserve now must be at least this multiple of the reserve `lookback` slots ago. */
  growth: number;
  /** Price now must be at least this share of the lookback window's high. */
  nearHigh: number;
  /** Real SOL reserve (lamports) a curve must hold at decision time. */
  minRqSol: number;
  /** Distinct non-creator buyers in the lookback window, at least. */
  minBuyers: number;
  /** SOL to put into one position (each buy is still capped at 1% of the real reserve). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Slippage allowed on buys in bps; sells always go out wide open. */
  buySlipBps: number;
  /** Exit once the position is worth this much over its cost (fraction). */
  takeProfit: number;
  /** Exit once the position is worth this much under its cost (fraction). */
  stopLoss: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots (0 = never). */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots (0 = never). */
  staleSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
}

// Settings chosen on the dev window with the local engine port (tools/sim.ts in the kit's pilot),
// preferring a flat region of the grid over its single best cell: growth 1.5-2 with minRq 20 SOL
// and take-profit 1-3 all stay positive, and this cell keeps 25 coins (above the 20-coin bar)
// at +0.25 SOL net on the dev window. The tighter growth-2.0 cell scores higher (+0.44) but
// trades only 17 coins, below the minimum bar, so it is not used.
export const DEFAULT_PARAMS: Params = {
  minAge: 100,
  lookback: 100,
  growth: 1.7,
  nearHigh: 0.95,
  minRqSol: 20_000_000_000,
  minBuyers: 5,
  stakeSol: 0.2,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  takeProfit: 2.0,
  stopLoss: 0.2,
  trailArm: 0.2,
  trail: 0.15,
  maxHold: 0,
  staleSlots: 0,
  exitOnDevSell: true,
  cooldown: 0,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  price: number;
  rqSol: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface Coin {
  created: number | null;
  creator: Pubkey | null;
  /** Real SOL reserve at the CreateEvent (0: the curve starts empty). */
  vq0: bigint;
  vt0: bigint;
  /** Ticks inside the lookback window, oldest first. */
  ticks: Tick[];
  /** Last slot at which this coin was exited (for the cooldown). */
  lastExit: number;
  /** Entered once already (one entry per coin). */
  entered: boolean;
  /** Creator sold at least once. */
  devSold: boolean;
  /** Last slot any trade hit this coin. */
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** The position's cost basis in SOL (buys + tx fees paid), for exit math. */
  cost: number;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, creator: null, vq0: 0n, vt0: 1n, ticks: [], lastExit: -1e12, entered: false, devSold: false, lastTradeSlot: -1 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Entry signal on a curve's tape at slot `now`: deep, still growing, near its high. */
  const entrySignal = (c: Coin, now: number, rqSol: number): boolean => {
    if (c.created === null || now - c.created < p.minAge) return false;
    if (rqSol * LAMPORTS < p.minRqSol) return false;
    if (c.entered || now - c.lastExit < p.cooldown) return false;
    if (c.devSold) return false;
    const from = now - p.lookback;
    let i0 = 0;
    while (i0 < c.ticks.length && c.ticks[i0]!.slot <= from) i0++;
    if (i0 >= c.ticks.length) return false;
    const rq0 = c.ticks[i0]!.rqSol;
    if (rq0 <= 0 || rqSol < p.growth * rq0) return false;
    let high = 0;
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (let i = i0; i < c.ticks.length; i++) {
      const tr = c.ticks[i]!;
      if (tr.price > high) high = tr.price;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy && tr.user !== c.creator) buyers.add(tr.user);
    }
    if (buyers.size < p.minBuyers || net <= 0) return false;
    const last = c.ticks[c.ticks.length - 1]!;
    if (high <= 0 || last.price < p.nearHigh * high) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      // Read the batch into the tapes first: every decision below uses this batch's trades.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.ticks.push({
            slot: e.slot,
            price,
            rqSol: Number(e.real_quote_reserves) / LAMPORTS,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
          });
          c.lastTradeSlot = e.slot;
          if (!e.is_buy && e.user === c.creator) c.devSold = true;
          // Drop ticks older than the lookback window (plus a small margin).
          let cut = 0;
          while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - p.lookback - 5) cut++;
          if (cut > 0) c.ticks.splice(0, cut);
        } else if (e.event === 'CompleteEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) c.entered = true; // a completed curve is done for us
        }
      }

      // Our own fills: track which positions opened and what the sells cost us.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy' && !held.has(f.mint)) {
          held.set(f.mint, { opened: f.slot, peakValue: 0, cost: 0, exiting: false });
        }
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !state.pending.has(mint) && !selling.has(mint)) {
          const c = coins.get(mint);
          if (c !== undefined) c.lastExit = now;
          held.delete(mint);
        }
      }
      // Rebuild cost basis from the position the harness reports (cost_lamports is exact).
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingByMint.add(po.order.mint);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;

      // Exits first: stop loss, take-profit, trailing stop, stale, creator sell, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (selling.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = Number(sellValue(pos.token_amount, vq, vt)) / LAMPORTS - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS + tx;
        if (h.cost === 0) h.cost = cost;
        if (value > h.peakValue) h.peakValue = value;
        const c = coins.get(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        else if (value <= cost * (1 - p.stopLoss)) exit = true;
        else if (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        else if (p.maxHold > 0 && now - h.opened >= p.maxHold) exit = true;
        else if (p.staleSlots > 0 && c !== undefined && now - c.lastTradeSlot >= p.staleSlots) exit = true;
        else if (p.exitOnDevSell && c !== undefined && c.devSold) exit = true;
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        h.exiting = true;
      }

      // Entries: one probe per qualifying coin, while slots and cash allow.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, c] of coins) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (held.has(mint) || selling.has(mint) || pendingByMint.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(c, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft--;
        c.entered = true;
      }
      return orders;
    },
  };
}
