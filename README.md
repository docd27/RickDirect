# RickDirect

## What is this?
An express app that rickrolls you if you `curl` it. With apologies to [CJ of Coding Garden](https://twitter.com/coding_garden).

## Setup
1. Install dependencies: `npm install`
    - Note that `image-to-ascii` works best with `GraphicsMagick` installed on your system
    *(and the alternative deps fail to build on my system)*
        - Install with your package manager, Windows users download from http://www.graphicsmagick.org/
2. Obtain Rick Astley's seminal 1987 cultural masterpiece:
    - You'll need `ffmpeg` installed to convert the video frames to images
    - `mkdir ./data && cd ./data`
    - `wget https://archive.org/serve/Rick_Astley_Never_Gonna_Give_You_Up/Rick_Astley_Never_Gonna_Give_You_Up.mp4`
        - Note: the subtitles in `subtitles.json` are timed to this version of the video
    - The asciification script expects images in the `data` folder named `image%d.jpg` where `%d` is the frame number
    - `ffmpeg -i Rick_Astley_Never_Gonna_Give_You_Up.mp4 image%d.jpg`
3. Asciify it
    - `npm run gen`
    - This will take a long time (the video is about 5000 frames). Eventually it will write compressed ascii frame data to `./data/data.json`
4. Run the webserver
    - `npm start`
    - Listens on loopback port 6001.

## Deployment
You will need to make sure there is no http / network buffering happening between node and the client. This will probably involve explicitly configuring anything in front of it like nginx etc to not cache / buffer, and it performs best over HTTP/2 for those same reasons. We're abusing chunked Transfer-Encoding to make this work.
