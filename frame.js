const fs = require('fs'), {promisify} = require('util'), zlib = require('zlib');
const imageToAscii = promisify(require('image-to-ascii'));
const stripAnsi = require('strip-ansi');
const DATA_PATH = './data/', DATA_FILE = DATA_PATH + 'data.json';
const DATA_FPS = 25;
const DATA_FRAMEINTERVAL = (1000 / DATA_FPS) | 0;
// Convert mp4 to jpegs with ffmpeg -i Rick_Astley_Never_Gonna_Give_You_Up.mp4 image%d.jpg

const genFrameData = async () => {
  console.log('Reading image files...');
  let frames = [];
  const files = await promisify(fs.readdir)(DATA_PATH);
  for (const file of files) {
    const matches = file.match(/^image(\d+)\.jpg$/);
    if (matches) {
      const fileNo = Number.parseInt(matches[1]);
      if (Number.isInteger(fileNo)) {
        frames.push({fileNo, fileName: matches[0]});
      }
    }
  }
  frames.sort(({fileNo: a}, {fileNo: b}) => a - b);

  // frames = frames.slice(0, 100);

  let frameNum = 1;
  for (let i = 0; i < frames.length; i++, frameNum++) {
    const frame = frames[i];
    if (frame.fileNo > frameNum) {
      console.log(`Missing frame: ${frameNum}`);
      frameNum = frame.fileNo;
    }
    console.log(`read ${DATA_PATH + frame.fileName}`);
    const asciiFrame = await imageToAscii(DATA_PATH + frame.fileName,
        {image_type: 'jpg', size: {height: '100%', width: '100%'}, size_options: {screen_size: {width: 60, height: 18}, preserve_aspect_ratio: false}});
    frame.data = asciiFrame;
  }
  console.log(`Writing to ${DATA_FILE}`);
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  fs.writeFileSync(DATA_FILE, zlib.deflateSync(JSON.stringify(frames)).toString('base64'), 'utf8');
  console.log(`Completed`);
  return true;
};

const loadFrameData = () => {
  if (!fs.existsSync(DATA_FILE)) throw new Error('Data missing, need to generate');
  const frameData = JSON.parse(zlib.inflateSync(Buffer.from(fs.readFileSync(DATA_FILE, 'utf8'), 'base64')));
  const frameWidth = stripAnsi(frameData[0].data.split('\n')[0]).length;
  return [DATA_FPS, DATA_FRAMEINTERVAL, frameWidth, frameData];
};

const SUBTITLE_FILE = './subtitles.json';
const loadSubtitleData = () => {
  const parseTimecode = (timecode) => {
    const [minStr, secStr] = timecode.split(':');
    const secs = Number.parseFloat(secStr);
    const mins = Number.parseInt(minStr);
    const timeSecs = mins * 60 + secs;
    if (!Number.isFinite(timeSecs)) throw new Error('Invalid timecode');
    const frameIndex = timeSecs * DATA_FPS | 0;
    return frameIndex;
  };
  if (!fs.existsSync(SUBTITLE_FILE)) throw new Error('Subtitle data missing');
  const subtitleData = JSON.parse(fs.readFileSync(SUBTITLE_FILE, 'utf8'));
  for (let i = 0; i < subtitleData.length; i++) {
    subtitleData[i].frameIndex = parseTimecode(subtitleData[i].time);
  }
  subtitleData.sort(({frameIndex: a}, {frameIndex: b}) => a - b);
  return subtitleData;
};

exports.genFrameData = genFrameData;
exports.loadFrameData = loadFrameData;
exports.loadSubtitleData = loadSubtitleData;
