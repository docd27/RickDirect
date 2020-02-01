/* eslint-disable require-jsdoc */
const VAD = require('node-vad');
const VADStream = require('./vadstream.js');
const Ds = require('deepspeech');
const EventEmitter = require('events');

const totalTime = (hrtimeValue) => (hrtimeValue[0] + hrtimeValue[1] / 1000000000).toPrecision(4);

class SpeechTranscriber extends EventEmitter {
  constructor(params = {}) {
    super();
    const defaultSettings = {
      BEAM_WIDTH: 1024,
      // BEAM_WIDTH: 500,
      LM_ALPHA: 0.75,
      LM_BETA: 1.85,
      AUDIO_SAMPLE_RATE: 16000,
      VAD_MODE: VAD.Mode.NORMAL,
      DEBOUNCE_TIME: 1000,
      INTERMEDIATE_TIME: 1000,
      DEBUG_SILENCE: false,
      DEBUG_PERF: false,
    };
    this.params = {...defaultSettings, params};
    // divde by two because each sample is 16 bits = 2 bytes
    this.params.TIME_MULTIPLIER_MS = (1000 / this.params.AUDIO_SAMPLE_RATE) / 2;
    this.ready = false;
    this.model = null;
  }
  loadModel(modelPath, lmPath, triePath) {
    const {DEBUG_PERF, BEAM_WIDTH, LM_ALPHA, LM_BETA} = this.params;
    if (this.model) throw new Error('Already loaded');

    if (DEBUG_PERF) console.error('Loading model from file %s', modelPath);
    const modelLoadStart = process.hrtime();
    this.model = new Ds.Model(modelPath, BEAM_WIDTH);
    const modelLoadEnd = process.hrtime(modelLoadStart);
    if (DEBUG_PERF) console.error('Loaded model in %ds.', totalTime(modelLoadEnd));

    if (lmPath && triePath) {
      if (DEBUG_PERF) console.error('Loading language model from files %s %s', lmPath, triePath);
      const lmLoadStart = process.hrtime();
      this.model.enableDecoderWithLM(lmPath, triePath, LM_ALPHA, LM_BETA);
      const lmLoadEnd = process.hrtime(lmLoadStart);
      if (DEBUG_PERF) console.error('Loaded language model in %ds.', totalTime(lmLoadEnd));
    }
    this.ready = true;
  }
  processStream(stream) {
    if (!this.ready) throw new Error('Not ready');
    const vadStream = new VADStream({
      mode: this.params.VAD_MODE,
      audioFrequency: this.params.AUDIO_SAMPLE_RATE,
      debounceTime: this.params.DEBOUNCE_TIME,
    });
    let model = this.model;
    const {INTERMEDIATE_TIME, DEBUG_SILENCE, DEBUG_PERF, TIME_MULTIPLIER_MS} = this.params;
    let intermediateResultBuffer = [];
    let audioLength = 0;
    let audioStartTimestamp = 0;
    let sctx = this.model.createStream();

    // const forceStrCopy = (str) => (' ' + str).slice(1); // garbage collection pls v8
    const chunkMetadata = (metadata) => {
      const result = [];
      if (metadata.items) {
        const letterResults = metadata.items;
        if (letterResults.length === 1 &&
          (letterResults[0].character === 'i' || letterResults[0].character === 'a')) {
          // bug in DeepSpeech 0.6 causes silence to be inferred as "i" or "a"
        } else {
          let wordBuffer = null;
          let wordStart = 0;
          for (let i = 0; i < letterResults.length; i++) {
            if (letterResults[i].character === ' ') {
              result.push({timestamp: wordStart, word: wordBuffer});
              wordBuffer = null;
            } else {
              if (wordBuffer === null) {
                // wordBuffer = forceStrCopy(letterResults[i].character);
                wordBuffer = letterResults[i].character;
                wordStart = Math.trunc(audioStartTimestamp + letterResults[i].start_time * 1000);
              } else {
                // wordBuffer += forceStrCopy(letterResults[i].character);
                wordBuffer += letterResults[i].character;
              }
            }
          }
          if (wordBuffer !== null) {
            result.push({timestamp: wordStart, word: wordBuffer});
            wordBuffer = null;
          }
        }
      }
      return result;
    };
    const updateIntermediateResultBuffer = (metadata) => {
      const wordResults = chunkMetadata(metadata);
      let i = 0;
      while (i < wordResults.length && i < intermediateResultBuffer.length &&
        wordResults[i].word === intermediateResultBuffer[i].word) {
        ++i;
      }
      const modIdx = i;
      let changed = false;
      while (i < wordResults.length && i < intermediateResultBuffer.length) {
        changed = true;
        this.emit('delete');
        intermediateResultBuffer[i] = wordResults[i];
        ++i;
      }
      while (intermediateResultBuffer.length > wordResults.length) { // letterResults shorter than intermediateResultBuffer
        changed = true;
        this.emit('delete');
        intermediateResultBuffer.pop();
      }
      for (let k = modIdx; k < i; k++) {
        changed = true;
        this.emit('word', intermediateResultBuffer[k]);
      }
      while (i < wordResults.length) {
        intermediateResultBuffer[i] = wordResults[i];
        changed = true;
        this.emit('word', intermediateResultBuffer[i]);
        ++i;
      }
      if (changed) this.emit('updated');
    };
    const finishStream = () => {
      const finishStreamStart = process.hrtime();
      const finishMetadata = model.finishStreamWithMetadata(sctx);
      const finishStreamEnd = process.hrtime(finishStreamStart);
      if (DEBUG_PERF) {
        console.error('Inference took %ds for %dms audio file.',
            totalTime(finishStreamEnd), audioLength);
      }
      updateIntermediateResultBuffer(finishMetadata);
      audioLength = 0;
      intermediateResultBuffer = [];
    };
    const intermediateDecode = () => {
      const intermediateDecodeStart = process.hrtime();
      const intermediateMetadata = model.intermediateDecodeWithMetadata(sctx);
      const intermediateDecodeEnd = process.hrtime(intermediateDecodeStart);
      if (DEBUG_PERF) {
        console.error('Inference took %ds for %dms audio file.',
            totalTime(intermediateDecodeEnd), audioLength);
      }
      updateIntermediateResultBuffer(intermediateMetadata);
      // Ds.FreeMetadata(intermediateMetadata); // should not be required
    };
    const feedAudioContent = (chunk) => {
      audioLength += chunk.length * TIME_MULTIPLIER_MS;
      model.feedAudioContent(sctx, chunk);
    };
    const endOfChunk = () => {
      finishStream();
      sctx = model.createStream();
    };
    let silenceBuffers = [];
    const vadBufferSilence = (data) => {
      // VAD has a tendency to cut the first bit of audio data from the start of a recording
      // so keep a buffer of that first bit of audio and in addBufferedSilence() reattach it to the beginning of the recording
      silenceBuffers.push(data);
      if (silenceBuffers.length >= 3) {
        silenceBuffers.shift();
      }
    };
    const addBufferedSilence = (data, startTimeMS) => {
      if (silenceBuffers.length) {
        let extraLength = 0;
        silenceBuffers.forEach((buf) => {
          extraLength += buf.length;
        });
        silenceBuffers.push(data);
        const length = extraLength + data.length;
        const audioBuffer = Buffer.concat(silenceBuffers, length);
        silenceBuffers = [];
        const extraLengthTime = extraLength * TIME_MULTIPLIER_MS;
        if (DEBUG_SILENCE) console.error('Added %dms of skipped silence to chunk.', extraLengthTime.toPrecision(4));
        return [audioBuffer, startTimeMS - extraLengthTime];
      } else {
        return [data, startTimeMS];
      }
    };
    let prevAudioLength = 0;
    const onVadChunk = (data) => {
      if (data.speech.start||data.speech.state) {
        if (data.speech.start) {
          const startTimeMS = data.speech.startTime || 0;
          const [audioDataAdjusted, adjustedStartTime] = addBufferedSilence(data.audioData, startTimeMS);
          audioStartTimestamp = adjustedStartTime;
          feedAudioContent(audioDataAdjusted);
        } else { // Middle
          feedAudioContent(data.audioData);
        }
        if (audioLength - prevAudioLength >= INTERMEDIATE_TIME) {
          intermediateDecode();
          prevAudioLength = audioLength;
        }
      } else if (data.speech.end) {
        silenceBuffers = [];
        prevAudioLength = 0;
        feedAudioContent(data.audioData);
        endOfChunk();
        this.emit('chunkend');
      } else if (data.speech.event === VAD.Event.SILENCE) {
        vadBufferSilence(data.audioData);
      }
    };
    const onVadEnd = () => {
      endOfChunk();
      sctx = null;
      model = null;
      this.model = null; // Note this means the class is not reuseable for multiple transcriptions, but fixes garbage collection
      this.emit('finish');
    };
    const vadOutputStream = stream.pipe(vadStream);
    vadOutputStream.on('data', onVadChunk);
    vadOutputStream.on('end', onVadEnd);
  }
}

module.exports = {
  SpeechTranscriber,
};
