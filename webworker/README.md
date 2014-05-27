# WebWorker port of lzma-purejs

This port has been built by assembling different libraries from lzma-purejs projectand others.


## Files

__lzma.js__

Implements the LZMA wrapper class that initializes WebWorker and manage compression/decompression requests.

__lzma.worker.js__

Includes LZMA implementation from lzma-purejs project and browser-buffer to enable browser support.

__utf8.conv.js__

Includes stringToUtf8ByteArray() and utf8ByteArrayToString() from Google Closure library for string encoding to/from UTF8 byte array.


## lzma.worker.js structure

* webworker related stuff
* lib/makeBuffer.js
* lib/LZ/InWindow.js
* lib/LZ/OutWindow.js
* lib/LZ/BinTree.js
* lib/RangeCoder/Encoder.js
* lib/RangeCoder/BitTreeDecoder.js
* lib/RangeCoder/BitTreeEncoder.js
* lib/RangeCoder/Decoder.js
* lib/LZMA/Base.js
* lib/LZMA/Decoder.js
* lib/LZMA/Encoder.js
* lib/Stream.js
* lib/Util.js
* lib/makeBuffer.js
* https://github.com/marcominetti/browser-buffer/blob/master/src/browser-buffer.js (forked from https://github.com/arextar/browser-buffer)


## How to install

Add lzma.js and utf8.conv.js libraries into your app.

```html
<script src="/path/to/lzma.js"></script>
<script src="/path/to/utf8.conv.js"></script>
```

Copy (and minify) lzma.worker.js somewhere on your server.

Modify lzma.js to fine-tune namespaces and string-bytearray encoding (if you need it).


## How to use

```javascript
var LZMAWrapper = new LZMA('/path/to/lzma.worker.js');
var LZMAData = null;
LZMAWrapper.Compress('string-to-compress...',3,function(CompressedByteArray){ LZMAData = CompressedByteArray; });
LZMAWrapper.Compress(new Uint8Array(stringToUtf8ByteArray('string-to-compress...')),3,function(CompressedByteArray){ LZMAData = CompressedByteArray; });

[...]

LZMAWrapper.Decompress(LZMAData,function(DecompressedByteArray){ console.log(utf8ByteArrayToString(DecompressedByteArray)) });
```

### .Compress() synopsis

LZMAWrapper.Compress(DataAsStringOrUint8Array,CompressLevelAsInt,CallBackFunction);

CompressLevelAsInt can be a 1-9 integer for compression level. More info in lzma.worker.js at option_mapping var declaration and LZMA-SDK.


### .Decompress() synopsis

LZMAWrapper.Decompress(DataAsStringOrUint8Array,CallBackFunction);


### Missing

Error handling: an error callback function support could be implemented.


## References

lzma-purejs - https://github.com/cscott/lzma-purejs

Google Closure library (for UTF8Array[] <> string encoding) - https://github.com/google/closure-library

browser-buffer - https://github.com/arextar/browser-buffer


## License (for the WebWorker ported version)

> Copyright (c) 2011 Gary Linscott
>
> Copyright (c) 2011-2012 Juan Mellado
>
> Copyright (c) 2013 C. Scott Ananian
>
> Copyright (c) 2014 Marco Minetti
>
> All rights reserved.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.
