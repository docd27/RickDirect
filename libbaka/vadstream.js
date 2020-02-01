/* eslint-disable require-jsdoc */
const VAD = require('node-vad');
const {Transform} = require('stream');
const {Buffer} = require('buffer');

class VADStream extends Transform {
  constructor(
      {
        mode = VAD.Mode.NORMAL,
        audioFrequency = 16000,
        debounceTime = 1000,
      } = {}) {
    super({
      writableObjectMode: false,
      readableObjectMode: true,
    });
    this.vad = new VAD(mode);

    if (typeof audioFrequency !== 'number') {
      throw new Error('audioFrequency must be a number');
    }
    if (!(audioFrequency === 8000 ||
          audioFrequency === 16000 ||
          audioFrequency === 32000 ||
          audioFrequency === 48000)) {
      throw new Error('audioFrequency must be 8000, 16000, 32000 or 48000');
    }
    this.audioFrequency = audioFrequency;

    if (typeof debounceTime !== 'number') {
      throw new Error('debounceTime must be a number');
    }
    if (debounceTime < 0) {
      throw new Error('debounceTime must be greater than 0');
    }

    this.debounceTime = debounceTime;

    this.timeMultiplier = (1000 / this.audioFrequency) / 2;
    this.chunkLength = 60 / this.timeMultiplier;
    this.byteCount = 0;
    this.state = false;
    this.startTime = 0;
    this.lastSpeech = 0;

    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    return this._chunkTransform(Buffer.concat([this.buffer, chunk]), 0)
        .then((remaining) => {
          this.buffer = remaining;
          callback();
        })
        .catch((err) => {
          this.buffer = null;
          callback(err);
        });
  }

  _chunkTransform(chunk, start) {
    const end = start + this.chunkLength;
    if (end < chunk.length) {
      return this._processAudio(chunk.slice(start, end))
          .then(() => this._chunkTransform(chunk, end));
    }
    return Promise.resolve(chunk.slice(start));
  }

  _processAudio(chunk) {
    const time = this.timeMultiplier * this.byteCount;
    this.byteCount += chunk.length;

    return this.vad.processAudio(chunk, this.audioFrequency).then((event) => {
      if (event === VAD.Event.ERROR) {
        throw new Error('Error in VAD');
      }

      let start = false;
      let end = false;
      let startTime = this.startTime;
      const duration = this.state ? time - this.startTime : 0;

      if (event === VAD.Event.VOICE) {
        if (!this.state) {
          start = true;
          startTime = time;
          end = false;
          this.state = true;
          this.startTime = time;
        }

        this.lastSpeech = time;
      } else if (this.state && (time - this.lastSpeech > this.debounceTime)) {
        start = false;
        end = true;
        this.state = false;
        this.startTime = 0;
      }

      this.push({
        time: time,
        audioData: chunk,
        speech: {
          state: this.state,
          event: event,
          start: start,
          end: end,
          startTime: startTime,
          duration: duration,
        },
      });
    });
  }
}

module.exports = VADStream;
