const {SpeechTranscriber, objectWriterStream} = require('./libbaka');
const argparse = require('argparse');
const net = require('net');

const parser = new argparse.ArgumentParser({addHelp: true, description: 'Running DeepSpeech inference.'});
parser.addArgument(['--model'], {required: true, help: 'Path to the model (protocol buffer binary file)'});
parser.addArgument(['--lm'], {help: 'Path to the language model binary file', nargs: '?'});
parser.addArgument(['--trie'], {help: 'Path to the language model trie file created with native_client/generate_trie', nargs: '?'});
parser.addArgument(['--fd'], {required: true, type: 'int', help: 'File descriptor to write output to'});
const args = parser.parseArgs();

const fd = args['fd'] | 0;
const pipe = new net.Socket({fd: fd});
const pipeWriter = objectWriterStream(pipe);

let transcriber = new SpeechTranscriber();
transcriber.loadModel(args['model'], args['lm'], args['trie']);

let transcription = [];

transcriber.on('delete', () => transcription.push({type: 'delete'}));
transcriber.on('word', (result) => transcription.push({type: 'word', value: result}));
transcriber.on('updated', () => {
  pipeWriter.writeObject(transcription);
  transcription = [];
});

transcriber.on('chunkend', () => {
  // console.error('Begin GC');
  // global.gc(true);
  // console.error('End GC');
});

transcriber.once('finish', () => {
  pipeWriter.done();
  // console.error('Cleaning refs');
  transcriber = null;
  // console.error('Begin GC');
  // global.gc(true);
  // console.error('End GC');
});

transcriber.processStream(process.stdin);

