const {introGenerator, frameSync, frameWriterStream, terminalFrameWriter} = require('./libbaka');

(async () => {
  const frameSource = frameSync(introGenerator('CodingGarden')())();

  await terminalFrameWriter(frameSource, process.stdout, true);
})().catch((err) => console.error(err));

