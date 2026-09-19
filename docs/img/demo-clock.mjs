// Preloaded by demo-board.sh (node --import) so the demo board's history is
// spread over days instead of the few seconds the script takes to run. It
// shifts the process clock back by GW_DEMO_CLOCK_MS; gw itself is unchanged
// and still does every write.
const offset = Number(process.env.GW_DEMO_CLOCK_MS || 0);
if (offset > 0) {
  const RealDate = Date;
  class DemoDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() - offset);
      else super(...args);
    }
    static now() { return RealDate.now() - offset; }
  }
  globalThis.Date = DemoDate;
}
