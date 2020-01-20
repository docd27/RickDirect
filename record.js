const {frameGeneratorStream, frameSync, frameWriterStreamAsync, gzipFileStream, outFileStream, frameWriter} = require('./libbaka');

const program = require('commander');
// program.option('-v, --verbose', 'Verbose output');
// program.option('-d, --debug', 'Debug mode');
program.usage("[options] filename")
program.parse(process.argv);
if (program.args.length !== 1) {
  program.outputHelp();
  return;
}
const fileName = program.args[0];

(async () => {
  const frameSource = frameSync(frameGeneratorStream(process.stdin)(), false)();
  await frameWriter(frameSource, frameWriterStreamAsync(gzipFileStream(fileName)));
})().catch((err) => console.error(err));

