// The harness runs `node /bot/main.ts` (Node 22). It reads every case from /input/cases.json (a JSON array of {id, input}),
// answers each case alone with solve.js and writes /output/answers.json, a JSON array of the answers in the cases' order.
// solve.js's emitJSON(input, flush) writes the case's answer as ASCII-only JSON text (the value JSON.stringify(run(input))
// reads back as) into a buffer and hands it to flush, which writes it to the file. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported so all of its work runs under them: incremental marking off (as the house
// baseline runs), and no TurboFan inlining: under one CPU the optimising compiler's background threads are timed too,
// and inlining makes each optimised compile several times larger than the time it saves on this short run. For the
// same reason TurboFan is asked for later (invocation budgets about 8x the defaults of 3000 and 800): Maglev's code is near TurboFan's here and
// far cheaper to make, so only the hottest loops (Markdown, escaping) are worth TurboFan on a run this short.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbo-inlining');
setFlagsFromString('--invocation-count-for-turbofan=24000');
setFlagsFromString('--invocation-count-for-osr=6000');

const { emitJSON } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  emitJSON: (input: unknown, flush: (bytes: Buffer, length: number) => void) => void;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
const write = (bytes: Buffer, length: number): void => {
  let off = 0;
  while (off < length) off += writeSync(fd, bytes, off, length - off);
};
write(Buffer.from('['), 1);
for (let i = 0; i < cases.length; i++) {
  if (i > 0) write(Buffer.from(','), 1);
  emitJSON(cases[i]!.input, write);
}
write(Buffer.from(']'), 1);
closeSync(fd);
