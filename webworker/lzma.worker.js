/*
 LZMA-JS 0.9.3 | github.com/cscott/lzma-purejs | (c) 2011-2013 Gary Linscott, Juan Mellado, Scott Ananian, Marco Minetti | MIT */
self.onmessage = function(event) {
	var Packet = event.data;
	var Result = null;
	var PacketID = Packet.PacketID;
	try {
		if (Packet.Data == null) {
			throw new Error('No input data.');
		}

		if (Packet.Type == "compress") {
			 //C: checking if input is valid 
	        if (Packet.Data.constructor != Uint8Array) {
	        	throw new Error('Input data is not Uint8Array.');
	        }
	       	//C: encoding data
			Result = Util.compressFile(Packet.Data,null,Packet.Level,null);
		} else if (Packet.Type == "decompress") {
			//C: checking if input is valid
			if (Packet.Data.constructor != Uint8Array) {
	        	throw new Error('Input data is not Uint8Array.');
	        }
			//C: decoding data
			Result = Util.decompressFile(Packet.Data,null);
		}
		if(PacketID != null) 
			postMessage({"PacketID":Packet.PacketID, "Result":Result});
		else
			postMessage({"Result":Result});
	} catch (CaughtException) {
		if(PacketID != null) 
			postMessage({"PacketID":Packet.PacketID, "Error":CaughtException.message});
		else
			postMessage({"Error":CaughtException.message});
	}
};


/* lib/makeBuffer.js */
// typed array / Buffer compatibility.
var makeBuffer = function (len) {
    var b = [],
        i;
    for (i = 0; i < len; i++) {
        b[i] = 0;
    }
    return b;
};
if (typeof (Uint8Array) !== 'undefined') {
    makeBuffer = function (len) {
        return new Uint8Array(len);
    };
} else if (typeof (Buffer) !== 'undefined') {
    makeBuffer = function (len) {
        var b = new Buffer(len);
        b.fill(0); // zero-fill, for consistency
        return b;
    };
}

var LZ = (function () {

    /* lib/LZ/InWindow.js */

    var InWindow = function (keepSizeBefore, keepSizeAfter, keepSizeReserve, stream) {
        if (arguments.length >= 4) {
            // typical initialization sequence
            var args = Array.prototype.slice.call(arguments, 0);
            var _stream = args.pop();
            this.create.apply(this, args);
            this.setStream(_stream);
            this.init();
        }
    };

    InWindow.prototype.moveBlock = function () {
        var i;
        var offset = this._bufferOffset + this._pos + this._keepSizeBefore;
        // we need one additional byte, since MovePos moves on 1 byte.
        if (offset > 0) {
            offset--;
        }

        var numBytes = this._bufferOffset + this._streamPos - offset;
        for (i = 0; i < numBytes; i++) {
            this._bufferBase[i] = this._bufferBase[offset + i];
        }
        this._bufferOffset -= offset;
    };

    InWindow.prototype.readBlock = function () {
        if (this._streamEndWasReached) {
            return;
        }
        while (true) {
            var size = -this._bufferOffset + this._blockSize - this._streamPos;
            if (size === 0) {
                return;
            }
            var numReadBytes =
                this._stream.read(this._bufferBase,
                    this._bufferOffset + this._streamPos,
                    size);
            if (numReadBytes <= 0) {
                this._posLimit = this._streamPos;
                var pointerToPosition = this._bufferOffset + this._posLimit;
                if (pointerToPosition > this._pointerToLastSafePosition) {
                    this._posLimit = this._pointerToLastSafePosition - this._bufferOffset;
                }

                this._streamEndWasReached = true;
                return;
            }
            this._streamPos += numReadBytes;
            if (this._streamPos >= this._pos + this._keepSizeAfter) {
                this._posLimit = this._streamPos - this._keepSizeAfter;
            }
        }
    };

    InWindow.prototype.free = function () {
        this._bufferBase = null;
    };

    InWindow.prototype.create = function (keepSizeBefore, keepSizeAfter, keepSizeReserve) {
        this._keepSizeBefore = keepSizeBefore;
        this._keepSizeAfter = keepSizeAfter;
        var blockSize = keepSizeBefore + keepSizeAfter + keepSizeReserve;
        if ((!this._bufferBase) || this._blockSize !== blockSize) {
            this.free();
            this._blockSize = blockSize;
            this._bufferBase = makeBuffer(this._blockSize);
        }
        this._pointerToLastSafePosition = this._blockSize - keepSizeAfter;
    };

    InWindow.prototype.setStream = function (stream) {
        this._stream = stream;
    };

    InWindow.prototype.releaseStream = function () {
        this._stream = null;
    };

    InWindow.prototype.init = function () {
        this._bufferOffset = 0;
        this._pos = 0;
        this._streamPos = 0;
        this._streamEndWasReached = false;
        this.readBlock();
    };

    InWindow.prototype.movePos = function () {
        this._pos++;
        if (this._pos > this._posLimit) {
            var pointerToPosition = this._bufferOffset + this._pos;
            if (pointerToPosition > this._pointerToLastSafePosition) {
                this.moveBlock();
            }
            this.readBlock();
        }
    };

    InWindow.prototype.getIndexByte = function (index) {
        return this._bufferBase[this._bufferOffset + this._pos + index];
    };

    // index + limit have not to exceed _keepSizeAfter
    InWindow.prototype.getMatchLen = function (index, distance, limit) {
        var pby, i;
        if (this._streamEndWasReached) {
            if (this._pos + index + limit > this._streamPos) {
                limit = this._streamPos - (this._pos + index);
            }
        }
        distance++;
        pby = this._bufferOffset + this._pos + index;
        for (i = 0; i < limit && this._bufferBase[pby + i] === this._bufferBase[pby + i - distance];) {
            i++;
        }
        return i;
    };

    InWindow.prototype.getNumAvailableBytes = function () {
        return this._streamPos - this._pos;
    };

    InWindow.prototype.reduceOffsets = function (subValue) {
        this._bufferOffset += subValue;
        this._posLimit -= subValue;
        this._pos -= subValue;
        this._streamPos -= subValue;
    };


    /* lib/LZ/OutWindow.js */
    var OutWindow = function () {
        this._windowSize = 0;
    };

    OutWindow.prototype.create = function (windowSize) {
        if ((!this._buffer) || (this._windowSize !== windowSize)) {
            this._buffer = makeBuffer(windowSize);
        }
        this._windowSize = windowSize;
        this._pos = 0;
        this._streamPos = 0;
    };

    OutWindow.prototype.flush = function () {
        var size = this._pos - this._streamPos;
        if (size !== 0) {
            while (size--) {
                this._stream.writeByte(this._buffer[this._streamPos++]);
            }
            if (this._pos >= this._windowSize) {
                this._pos = 0;
            }
            this._streamPos = this._pos;
        }
    };

    OutWindow.prototype.releaseStream = function () {
        this.flush();
        this._stream = null;
    };

    OutWindow.prototype.setStream = function (stream) {
        this.releaseStream();
        this._stream = stream;
    };

    OutWindow.prototype.init = function (solid) {
        if (!solid) {
            this._streamPos = 0;
            this._pos = 0;
        }
    };

    OutWindow.prototype.copyBlock = function (distance, len) {
        var pos = this._pos - distance - 1;
        if (pos < 0) {
            pos += this._windowSize;
        }
        while (len--) {
            if (pos >= this._windowSize) {
                pos = 0;
            }
            this._buffer[this._pos++] = this._buffer[pos++];
            if (this._pos >= this._windowSize) {
                this.flush();
            }
        }
    };

    OutWindow.prototype.putByte = function (b) {
        this._buffer[this._pos++] = b;
        if (this._pos >= this._windowSize) {
            this.flush();
        }
    };

    OutWindow.prototype.getByte = function (distance) {
        var pos = this._pos - distance - 1;
        if (pos < 0) {
            pos += this._windowSize;
        }
        return this._buffer[pos];
    };

    /* lib/LZ/BinTree.js */
    var CrcTable = (function () {
        var table = [];
        if (typeof (Uint32Array) !== 'undefined') {
            table = new Uint32Array(256);
        }

        var kPoly = 0xEDB88320,
            i, j, r;
        for (i = 0; i < 256; i++) {
            r = i;
            for (j = 0; j < 8; j++) {
                if ((r & 1) !== 0) {
                    r = (r >>> 1) ^ kPoly;
                } else {
                    r >>>= 1;
                }
            }
            table[i] = r;
        }

        return table;
    })();

    // constants
    var kHash2Size = 1 << 10,
        kHash3Size = 1 << 16,
        kBT2HashSize = 1 << 16;
    var kStartMaxLen = 1,
        kHash3Offset = kHash2Size,
        kEmptyHashValue = 0;
    var kMaxValForNormalize = (1 << 30) - 1;

    function BinTree() {
        InWindow.call(this);
        this._cyclicBufferSize = 0;

        this._son = [];
        this._hash = [];

        this._cutValue = 0xFF;
        this._hashSizeSum = 0;

        this.HASH_ARRAY = true;

        this.kNumHashDirectBytes = 0;
        this.kMinMatchCheck = 4;
        this.kFixHashSize = kHash2Size + kHash3Size;

        if (arguments.length >= 6) {
            var args = Array.prototype.slice.call(arguments, 0);
            this.setType(args.shift());
            var stream = args.pop();
            this.create.apply(this, args);
            this.setStream(stream);
            this.init();
        }
    }
    // a little bit of sugar for super-method invocations.
    var _super_ = InWindow.prototype;
    BinTree.prototype = Object.create(_super_);

    BinTree.prototype.setType = function (numHashBytes) {
        this.HASH_ARRAY = numHashBytes > 2;
        if (this.HASH_ARRAY) {
            this.kNumHashDirectBytes = 0;
            this.kMinMatchCheck = 4;
            this.kFixHashSize = kHash2Size + kHash3Size;
        } else {
            this.kNumHashDirectBytes = 2;
            this.kMinMatchCheck = 2 + 1;
            this.kFixHashSize = 0;
        }
    };

    BinTree.prototype.init = function () {
        var i;
        _super_.init.call(this);
        for (i = 0; i < this._hashSizeSum; i++) {
            this._hash[i] = kEmptyHashValue;
        }
        this._cyclicBufferPos = 0;
        this.reduceOffsets(-1);
    };

    BinTree.prototype.movePos = function () {
        if (++this._cyclicBufferPos >= this._cyclicBufferSize) {
            this._cyclicBufferPos = 0;
        }
        _super_.movePos.call(this);
        if (this._pos === kMaxValForNormalize) {
            this.normalize();
        }
    };

    BinTree.prototype.create = function (historySize, keepAddBufferBefore, matchMaxLen, keepAddBufferAfter) {
        var windowReservSize, cyclicBufferSize, hs;

        if (historySize > kMaxValForNormalize - 256) {
            return false;
        }
        this._cutValue = 16 + (matchMaxLen >>> 1);

        windowReservSize = (historySize + keepAddBufferBefore +
            matchMaxLen + keepAddBufferAfter) / 2 + 256;

        _super_.create.call(this, historySize + keepAddBufferBefore,
            matchMaxLen + keepAddBufferAfter,
            windowReservSize);

        this._matchMaxLen = matchMaxLen;

        cyclicBufferSize = historySize + 1;
        if (this._cyclicBufferSize !== cyclicBufferSize) {
            this._cyclicBufferSize = cyclicBufferSize;
            this._son = [];
            this._son.length = cyclicBufferSize * 2;
        }

        hs = kBT2HashSize;

        if (this.HASH_ARRAY) {
            hs = historySize - 1;
            hs |= hs >>> 1;
            hs |= hs >>> 2;
            hs |= hs >>> 4;
            hs |= hs >>> 8;
            hs >>>= 1;
            hs |= 0xFFFF;
            if (hs > (1 << 24)) {
                hs >>>= 1;
            }
            this._hashMask = hs;
            hs++;
            hs += this.kFixHashSize;
        }
        if (hs !== this._hashSizeSum) {
            this._hashSizeSum = hs;
            this._hash = [];
            this._hash.length = this._hashSizeSum;
        }
        return true;
    };

    BinTree.prototype.getMatches = function (distances) {
        var lenLimit;
        if (this._pos + this._matchMaxLen <= this._streamPos) {
            lenLimit = this._matchMaxLen;
        } else {
            lenLimit = this._streamPos - this._pos;
            if (lenLimit < this.kMinMatchCheck) {
                this.movePos();
                return 0;
            }
        }

        var offset = 0;
        var matchMinPos = (this._pos > this._cyclicBufferSize) ? (this._pos - this._cyclicBufferSize) : 0;
        var cur = this._bufferOffset + this._pos;
        var maxLen = kStartMaxLen; // to avoid items for len < hashSize
        var hashValue = 0,
            hash2Value = 0,
            hash3Value = 0;

        if (this.HASH_ARRAY) {
            var temp = CrcTable[this._bufferBase[cur]] ^ this._bufferBase[cur + 1];
            hash2Value = temp & (kHash2Size - 1);
            temp ^= this._bufferBase[cur + 2] << 8;
            hash3Value = temp & (kHash3Size - 1);
            hashValue = (temp ^ (CrcTable[this._bufferBase[cur + 3]] << 5)) & this._hashMask;
        } else {
            hashValue = this._bufferBase[cur] ^ (this._bufferBase[cur + 1] << 8);
        }

        var curMatch = this._hash[this.kFixHashSize + hashValue];
        if (this.HASH_ARRAY) {
            var curMatch2 = this._hash[hash2Value];
            var curMatch3 = this._hash[kHash3Offset + hash3Value];
            this._hash[hash2Value] = this._pos;
            this._hash[kHash3Offset + hash3Value] = this._pos;
            if (curMatch2 > matchMinPos) {
                if (this._bufferBase[this._bufferOffset + curMatch2] === this._bufferBase[cur]) {
                    distances[offset++] = maxLen = 2;
                    distances[offset++] = this._pos - curMatch2 - 1;
                }
            }
            if (curMatch3 > matchMinPos) {
                if (this._bufferBase[this._bufferOffset + curMatch3] === this._bufferBase[cur]) {
                    if (curMatch3 === curMatch2) {
                        offset -= 2;
                    }
                    distances[offset++] = maxLen = 3;
                    distances[offset++] = this._pos - curMatch3 - 1;
                    curMatch2 = curMatch3;
                }
            }
            if (offset !== 0 && curMatch2 === curMatch) {
                offset -= 2;
                maxLen = kStartMaxLen;
            }
        }

        this._hash[this.kFixHashSize + hashValue] = this._pos;

        var ptr0 = (this._cyclicBufferPos << 1) + 1;
        var ptr1 = (this._cyclicBufferPos << 1);

        var len0, len1;
        len0 = len1 = this.kNumHashDirectBytes;

        if (this.kNumHashDirectBytes !== 0) {
            if (curMatch > matchMinPos) {
                if (this._bufferBase[this._bufferOffset + curMatch + this.kNumHashDirectBytes] !==
                    this._bufferBase[cur + this.kNumHashDirectBytes]) {
                    distances[offset++] = maxLen = this.kNumHashDirectBytes;
                    distances[offset++] = this._pos - curMatch - 1;
                }
            }
        }

        var count = this._cutValue;

        while (true) {
            if (curMatch <= matchMinPos || count-- === 0) {
                this._son[ptr0] = this._son[ptr1] = kEmptyHashValue;
                break;
            }

            var delta = this._pos - curMatch;
            var cyclicPos = ((delta <= this._cyclicBufferPos) ?
                (this._cyclicBufferPos - delta) :
                (this._cyclicBufferPos - delta + this._cyclicBufferSize)) << 1;

            var pby1 = this._bufferOffset + curMatch;
            var len = Math.min(len0, len1);
            if (this._bufferBase[pby1 + len] === this._bufferBase[cur + len]) {
                while (++len !== lenLimit) {
                    if (this._bufferBase[pby1 + len] !== this._bufferBase[cur + len]) {
                        break;
                    }
                }
                if (maxLen < len) {
                    distances[offset++] = maxLen = len;
                    distances[offset++] = delta - 1;
                    if (len === lenLimit) {
                        this._son[ptr1] = this._son[cyclicPos];
                        this._son[ptr0] = this._son[cyclicPos + 1];
                        break;
                    }
                }
            }
            if (this._bufferBase[pby1 + len] < this._bufferBase[cur + len]) {
                this._son[ptr1] = curMatch;
                ptr1 = cyclicPos + 1;
                curMatch = this._son[ptr1];
                len1 = len;
            } else {
                this._son[ptr0] = curMatch;
                ptr0 = cyclicPos;
                curMatch = this._son[ptr0];
                len0 = len;
            }
        }

        this.movePos();
        return offset;
    };

    BinTree.prototype.skip = function (num) {
        var lenLimit, matchMinPos, cur, curMatch, hashValue, hash2Value, hash3Value, temp;
        var ptr0, ptr1, len0, len1, count, delta, cyclicPos, pby1, len;
        do {
            if (this._pos + this._matchMaxLen <= this._streamPos) {
                lenLimit = this._matchMaxLen;
            } else {
                lenLimit = this._streamPos - this._pos;
                if (lenLimit < this.kMinMatchCheck) {
                    this.movePos();
                    continue;
                }
            }

            matchMinPos = this._pos > this._cyclicBufferSize ? (this._pos - this._cyclicBufferSize) : 0;
            cur = this._bufferOffset + this._pos;

            if (this.HASH_ARRAY) {
                temp = CrcTable[this._bufferBase[cur]] ^ this._bufferBase[cur + 1];
                hash2Value = temp & (kHash2Size - 1);
                this._hash[hash2Value] = this._pos;
                temp ^= this._bufferBase[cur + 2] << 8;
                hash3Value = temp & (kHash3Size - 1);
                this._hash[kHash3Offset + hash3Value] = this._pos;
                hashValue = (temp ^ (CrcTable[this._bufferBase[cur + 3]] << 5)) & this._hashMask;
            } else {
                hashValue = this._bufferBase[cur] ^ (this._bufferBase[cur + 1] << 8);
            }

            curMatch = this._hash[this.kFixHashSize + hashValue];
            this._hash[this.kFixHashSize + hashValue] = this._pos;

            ptr0 = (this._cyclicBufferPos << 1) + 1;
            ptr1 = (this._cyclicBufferPos << 1);

            len0 = len1 = this.kNumHashDirectBytes;

            count = this._cutValue;
            while (true) {
                if (curMatch <= matchMinPos || count-- === 0) {
                    this._son[ptr0] = this._son[ptr1] = kEmptyHashValue;
                    break;
                }

                delta = this._pos - curMatch;
                cyclicPos = (delta <= this._cyclicBufferPos ?
                    (this._cyclicBufferPos - delta) :
                    (this._cyclicBufferPos - delta + this._cyclicBufferSize)) << 1;

                pby1 = this._bufferOffset + curMatch;
                len = (len0 < len1) ? len0 : len1;
                if (this._bufferBase[pby1 + len] === this._bufferBase[cur + len]) {
                    while (++len !== lenLimit) {
                        if (this._bufferBase[pby1 + len] !== this._bufferBase[cur + len]) {
                            break;
                        }
                    }
                    if (len === lenLimit) {
                        this._son[ptr1] = this._son[cyclicPos];
                        this._son[ptr0] = this._son[cyclicPos + 1];
                        break;
                    }
                }
                if (this._bufferBase[pby1 + len] < this._bufferBase[cur + len]) {
                    this._son[ptr1] = curMatch;
                    ptr1 = cyclicPos + 1;
                    curMatch = this._son[ptr1];
                    len1 = len;
                } else {
                    this._son[ptr0] = curMatch;
                    ptr0 = cyclicPos;
                    curMatch = this._son[ptr0];
                    len0 = len;
                }
            }
            this.movePos();
        } while (--num !== 0);
    };

    BinTree.prototype.normalizeLinks = function (items, numItems, subValue) {
        var i, value;
        for (i = 0; i < numItems; i++) {
            value = items[i];
            if (value <= subValue) {
                value = kEmptyHashValue;
            } else {
                value -= subValue;
            }
            items[i] = value;
        }
    };

    BinTree.prototype.normalize = function () {
        var subValue = this._pos - this._cyclicBufferSize;
        this.normalizeLinks(this._son, this._cyclicBufferSize * 2, subValue);
        this.normalizeLinks(this._hash, this._hashSizeSum, subValue);
        this.reduceOffsets(subValue);
    };

    BinTree.prototype.setCutValue = function (cutValue) {
        this._cutValue = cutValue;
    };

    return {
        'BinTree': BinTree,
        'InWindow': InWindow,
        'OutWindow': OutWindow
    };

})();

var RangeCoder = (function () {


    /* lib/RangeCoder/Encoder.js */


    // largest 32/24/16/8-bit numbers.
    var MAX32 = 0xFFFFFFFF;
    var MAX24 = 0x00FFFFFF;
    var MAX16 = 0x0000FFFF;
    var MAX8 = 0x000000FF;
    var MASK24 = 0xFF000000; // 32-bit inverse of MAX24

    var kNumBitModelTotalBits = 11;
    var kBitModelTotal = (1 << kNumBitModelTotalBits);
    var kNumMoveBits = 5;

    var kNumMoveReducingBits = 2;
    var kNumBitPriceShiftBits = 6;

    var Encoder = function (stream) {
        this.init();
        if (stream) {
            this.setStream(stream);
        }
    };
    Encoder.prototype.setStream = function (stream) {
        this._stream = stream;
    };
    Encoder.prototype.releaseStream = function () {
        this._stream = null;
    };
    Encoder.prototype.init = function () {
        // The cache/cache_size variables are used to properly handle
        // carries, and represent a number defined by a big-endian sequence
        // starting with the cache value, and followed by cache_size 0xff
        // bytes, which has been shifted out of the low register, but hasn't
        // been written yet, because it could be incremented by one due to a
        // carry.

        // Note that the first byte output will always be 0 due to the fact
        // that cache and low are initialized to 0, and the encoder
        // implementation; the decoder ignores this byte.
        this._position = 0;
        this.low = 0; // unsigned 33-bit integer
        this.range = MAX32; // unsigned 32-bit integer
        // cacheSize needs to be large enough to store the full uncompressed
        // size; javascript's 2^53 limit should be enough
        this._cacheSize = 1;
        this._cache = 0; // unsigned 8-bit
    };
    Encoder.prototype.flushData = function () {
        var i;
        for (i = 0; i < 5; i++) {
            this.shiftLow();
        }
    };
    Encoder.prototype.flushStream = function () {
        if (this._stream.flush) {
            this._stream.flush();
        }
    };
    Encoder.prototype.shiftLow = function () {
        // "normalization"
        var overflow = (this.low > MAX32) ? 1 : 0;
        if (this.low < MASK24 || overflow) {
            this._position += this._cacheSize;
            var temp = this._cache;
            do {
                this._stream.writeByte((temp + overflow) & MAX8);
                temp = MAX8;
            } while (--this._cacheSize !== 0);
            // set cache to bits 24-31 of 'low'
            this._cache = this.low >>> 24; // this truncates correctly
            // set cache_size to 0 (do/while loop did this)
        }
        this._cacheSize++;
        // 'lowest 24 bits of low, shifted left by 8'
        // careful, '<< 8' can flip sign of 'low'
        this.low = (this.low & MAX24) * 256;
    };

    Encoder.prototype.encodeDirectBits = function (v, numTotalBits) {
        var i, mask;
        mask = 1 << (numTotalBits - 1);
        for (i = numTotalBits - 1; i >= 0; i--, mask >>>= 1) {
            this.range >>>= 1; // range is unsigned 32-bit int
            if (v & mask) {
                this.low += this.range;
            }
            if (this.range <= MAX24) {
                this.range *= 256; // careful not to flip sign
                this.shiftLow();
            }
        }
    };

    Encoder.prototype.getProcessedSizeAdd = function () {
        return this._cacheSize + this._position + 4;
    };

    Encoder.initBitModels = function (probs, len) {
        var i;
        if (len && !probs) {
            if (typeof (Uint16Array) !== 'undefined') {
                probs = new Uint16Array(len);
            } else {
                probs = [];
                probs.length = len;
            }
        }
        for (i = 0; i < probs.length; i++)
            probs[i] = (kBitModelTotal >>> 1); // 0.5 probability
        return probs;
    };

    Encoder.prototype.encode = function (probs, index, symbol) {
        var prob = probs[index];
        var newBound = (this.range >>> kNumBitModelTotalBits) * prob;
        if (symbol === 0) {
            this.range = newBound;
            probs[index] = prob + ((kBitModelTotal - prob) >>> kNumMoveBits);
        } else {
            this.low += newBound;
            this.range -= newBound;
            probs[index] = prob - (prob >>> kNumMoveBits);
        }
        if (this.range <= MAX24) {
            this.range *= 256; // careful not to flip sign
            this.shiftLow();
        }
    };

    var ProbPrices = [];
    if (typeof (Uint32Array) !== 'undefined') {
        ProbPrices = new Uint32Array(kBitModelTotal >>> kNumMoveReducingBits);
    }
    (function () {
        var kNumBits = (kNumBitModelTotalBits - kNumMoveReducingBits);
        var i, j;
        for (i = kNumBits - 1; i >= 0; i--) {
            var start = 1 << (kNumBits - i - 1);
            var end = 1 << (kNumBits - i);
            for (j = start; j < end; j++) {
                ProbPrices[j] = (i << kNumBitPriceShiftBits) +
                    (((end - j) << kNumBitPriceShiftBits) >>> (kNumBits - i - 1));
            }
        }
    })();

    Encoder.getPrice = function (prob, symbol) {
        return ProbPrices[(((prob - symbol) ^ ((-symbol))) & (kBitModelTotal - 1)) >>> kNumMoveReducingBits];
    };
    Encoder.getPrice0 = function (prob) {
        return ProbPrices[prob >>> kNumMoveReducingBits];
    };
    Encoder.getPrice1 = function (prob) {
        return ProbPrices[(kBitModelTotal - prob) >>> kNumMoveReducingBits];
    };

    // export constants for use in Encoder.
    Encoder.kNumBitPriceShiftBits = kNumBitPriceShiftBits;


    /* lib/RangeCoder/BitTreeDecoder.js */
    var BitTreeDecoder = function (numBitLevels) {
        this._numBitLevels = numBitLevels;
        this.init();
    };

    BitTreeDecoder.prototype.init = function () {
        this._models = Encoder.initBitModels(null, 1 << this._numBitLevels);
    };

    BitTreeDecoder.prototype.decode = function (rangeDecoder) {
        var m = 1,
            i = this._numBitLevels;

        while (i--) {
            m = (m << 1) | rangeDecoder.decodeBit(this._models, m);
        }
        return m - (1 << this._numBitLevels);
    };

    BitTreeDecoder.prototype.reverseDecode = function (rangeDecoder) {
        var m = 1,
            symbol = 0,
            i = 0,
            bit;

        for (; i < this._numBitLevels; ++i) {
            bit = rangeDecoder.decodeBit(this._models, m);
            m = (m << 1) | bit;
            symbol |= (bit << i);
        }
        return symbol;
    };

    BitTreeDecoder.reverseDecode = function (models, startIndex, rangeDecoder,
        numBitLevels) {
        var m = 1,
            symbol = 0,
            i = 0,
            bit;

        for (; i < numBitLevels; ++i) {
            bit = rangeDecoder.decodeBit(models, startIndex + m);
            m = (m << 1) | bit;
            symbol |= (bit << i);
        }
        return symbol;
    };


    /* lib/RangeCoder/BitTreeEncoder.js */
    var BitTreeEncoder = function (numBitLevels) {
        this._numBitLevels = numBitLevels;
        this.init();
    };
    BitTreeEncoder.prototype.init = function () {
        this._models = Encoder.initBitModels(null, 1 << this._numBitLevels);
    };

    BitTreeEncoder.prototype.encode = function (rangeEncoder, symbol) {
        var m = 1,
            bitIndex;
        for (bitIndex = this._numBitLevels; bitIndex > 0;) {
            bitIndex--;
            var bit = (symbol >>> bitIndex) & 1;
            rangeEncoder.encode(this._models, m, bit);
            m = (m << 1) | bit;
        }
    };

    BitTreeEncoder.prototype.reverseEncode = function (rangeEncoder, symbol) {
        var m = 1,
            i;
        for (i = 0; i < this._numBitLevels; i++) {
            var bit = symbol & 1;
            rangeEncoder.encode(this._models, m, bit);
            m = (m << 1) | bit;
            symbol >>>= 1;
        }
    };

    BitTreeEncoder.reverseEncode = function (models, startIndex, rangeEncoder, numBitLevels, symbol) {
        var m = 1,
            i;
        for (i = 0; i < numBitLevels; i++) {
            var bit = symbol & 1;
            rangeEncoder.encode(models, startIndex + m, bit);
            m = (m << 1) | bit;
            symbol >>>= 1;
        }
    };

    BitTreeEncoder.prototype.getPrice = function (symbol) {
        var price = 0,
            m = 1,
            bitIndex;
        for (bitIndex = this._numBitLevels; bitIndex > 0;) {
            bitIndex--;
            var bit = (symbol >>> bitIndex) & 1;
            price += Encoder.getPrice(this._models[m], bit);
            m = (m << 1) | bit;
        }
        return price;
    };

    BitTreeEncoder.prototype.reverseGetPrice = function (symbol) {
        var price = 0,
            m = 1,
            bitIndex;
        for (bitIndex = this._numBitLevels; bitIndex > 0; bitIndex--) {
            var bit = (symbol & 1);
            symbol >>>= 1;
            price += Encoder.getPrice(this._models[m], bit);
            m = (m << 1) | bit;
        }
        return price;
    };

    BitTreeEncoder.reverseGetPrice = function (models, startIndex,
        numBitLevels, symbol) {
        var price = 0,
            m = 1,
            bitIndex;
        for (bitIndex = numBitLevels; bitIndex > 0; bitIndex--) {
            var bit = (symbol & 1);
            symbol >>>= 1;
            price += Encoder.getPrice(models[startIndex + m], bit);
            m = (m << 1) | bit;
        }
        return price;
    };

    /* lib/RangeCoder/Decoder.js */

    var Decoder = function (stream) {
        if (stream) {
            this.setStream(stream);
            this.init();
        }
    };

    Decoder.prototype.setStream = function (stream) {
        this._stream = stream;
    };

    Decoder.prototype.releaseStream = function () {
        this._stream = null;
    };

    Decoder.prototype.init = function () {
        var i = 5;

        this._code = 0;
        this._range = -1;

        while (i--) {
            this._code = (this._code << 8) | this._stream.readByte();
        }
    };

    Decoder.prototype.decodeDirectBits = function (numTotalBits) {
        var result = 0,
            i = numTotalBits,
            t;

        while (i--) {
            this._range >>>= 1;
            t = (this._code - this._range) >>> 31;
            this._code -= this._range & (t - 1);
            result = (result << 1) | (1 - t);

            if ((this._range & 0xff000000) === 0) {
                this._code = (this._code << 8) | this._stream.readByte();
                this._range <<= 8;
            }
        }

        return result;
    };

    Decoder.prototype.decodeBit = function (probs, index) {
        var prob = probs[index],
            newBound = (this._range >>> 11) * prob;

        if ((this._code ^ 0x80000000) < (newBound ^ 0x80000000)) {
            this._range = newBound;
            probs[index] += (2048 - prob) >>> 5;
            if ((this._range & 0xff000000) === 0) {
                this._code = (this._code << 8) | this._stream.readByte();
                this._range <<= 8;
            }
            return 0;
        }

        this._range -= newBound;
        this._code -= newBound;
        probs[index] -= prob >>> 5;
        if ((this._range & 0xff000000) === 0) {
            this._code = (this._code << 8) | this._stream.readByte();
            this._range <<= 8;
        }
        return 1;
    };

    return {
        'BitTreeDecoder': BitTreeDecoder,
        'BitTreeEncoder': BitTreeEncoder,
        'Decoder': Decoder,
        'Encoder': Encoder
    };
})();


var LZMA = (function () {

    /* lib/LZMA/Base.js */

    /*
Copyright (c) 2011 Juan Mellado

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

    /*
References:
- "LZMA SDK" by Igor Pavlov
  http://www.7-zip.org/sdk.html
*/
    /* Original source found at: http://code.google.com/p/js-lzma/ */

    var Base = Object.create(null);
    Base.kNumRepDistances = 4;
    Base.kNumStates = 12;

    Base.stateInit = function () {
        return 0;
    };

    Base.stateUpdateChar = function (index) {
        if (index < 4) {
            return 0;
        }
        if (index < 10) {
            return index - 3;
        }
        return index - 6;
    };

    Base.stateUpdateMatch = function (index) {
        return (index < 7 ? 7 : 10);
    };

    Base.stateUpdateRep = function (index) {
        return (index < 7 ? 8 : 11);
    };

    Base.stateUpdateShortRep = function (index) {
        return (index < 7 ? 9 : 11);
    };

    Base.stateIsCharState = function (index) {
        return index < 7;
    };

    Base.kNumPosSlotBits = 6;
    Base.kDicLogSizeMin = 0;
    // Base.kDicLogSizeMax = 28;
    // Base.kDistTableSizeMax = Base.kDicLogSizeMax * 2;

    Base.kNumLenToPosStatesBits = 2; // it's for speed optimization
    Base.kNumLenToPosStates = 1 << Base.kNumLenToPosStatesBits;

    Base.kMatchMinLen = 2;

    Base.getLenToPosState = function (len) {
        len -= Base.kMatchMinLen;
        if (len < Base.kNumLenToPosStates) {
            return len;
        }
        return (Base.kNumLenToPosStates - 1);
    };

    Base.kNumAlignBits = 4;
    Base.kAlignTableSize = 1 << Base.kNumAlignBits;
    Base.kAlignMask = (Base.kAlignTableSize - 1);

    Base.kStartPosModelIndex = 4;
    Base.kEndPosModelIndex = 14;
    Base.kNumPosModels = Base.kEndPosModelIndex - Base.kStartPosModelIndex;

    Base.kNumFullDistances = 1 << (Base.kEndPosModelIndex / 2);

    Base.kNumLitPosStatesBitsEncodingMax = 4;
    Base.kNumLitContextBitsMax = 8;

    Base.kNumPosStatesBitsMax = 4;
    Base.kNumPosStatesMax = (1 << Base.kNumPosStatesBitsMax);
    Base.kNumPosStatesBitsEncodingMax = 4;
    Base.kNumPosStatesEncodingMax = (1 << Base.kNumPosStatesBitsEncodingMax);

    Base.kNumLowLenBits = 3;
    Base.kNumMidLenBits = 3;
    Base.kNumHighLenBits = 8;
    Base.kNumLowLenSymbols = 1 << Base.kNumLowLenBits;
    Base.kNumMidLenSymbols = 1 << Base.kNumMidLenBits;
    Base.kNumLenSymbols = Base.kNumLowLenSymbols + Base.kNumMidLenSymbols +
        (1 << Base.kNumHighLenBits);
    Base.kMatchMaxLen = Base.kMatchMinLen + Base.kNumLenSymbols - 1;

    /* lib/LZMA/Decoder.js */

    var initBitModels = RangeCoder.Encoder.initBitModels;

    var LenDecoder = function () {
        this._choice = initBitModels(null, 2);
        this._lowCoder = [];
        this._midCoder = [];
        this._highCoder = new RangeCoder.BitTreeDecoder(8);
        this._numPosStates = 0;
    };

    LenDecoder.prototype.create = function (numPosStates) {
        for (; this._numPosStates < numPosStates; ++this._numPosStates) {
            this._lowCoder[this._numPosStates] = new RangeCoder.BitTreeDecoder(3);
            this._midCoder[this._numPosStates] = new RangeCoder.BitTreeDecoder(3);
        }
    };

    LenDecoder.prototype.init = function () {
        var i = this._numPosStates;
        initBitModels(this._choice);
        while (i--) {
            this._lowCoder[i].init();
            this._midCoder[i].init();
        }
        this._highCoder.init();
    };

    LenDecoder.prototype.decode = function (rangeDecoder, posState) {
        if (rangeDecoder.decodeBit(this._choice, 0) === 0) {
            return this._lowCoder[posState].decode(rangeDecoder);
        }
        if (rangeDecoder.decodeBit(this._choice, 1) === 0) {
            return 8 + this._midCoder[posState].decode(rangeDecoder);
        }
        return 16 + this._highCoder.decode(rangeDecoder);
    };

    var LiteralDecoder = function () {};

    LiteralDecoder.Decoder2 = function () {
        this._decoders = initBitModels(null, 0x300);
    };

    LiteralDecoder.Decoder2.prototype.init = function () {
        initBitModels(this._decoders);
    };

    LiteralDecoder.Decoder2.prototype.decodeNormal = function (rangeDecoder) {
        var symbol = 1;

        do {
            symbol = (symbol << 1) | rangeDecoder.decodeBit(this._decoders, symbol);
        } while (symbol < 0x100);

        return symbol & 0xff;
    };

    LiteralDecoder.Decoder2.prototype.decodeWithMatchByte = function (rangeDecoder, matchByte) {
        var symbol = 1,
            matchBit, bit;

        do {
            matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            bit = rangeDecoder.decodeBit(this._decoders, ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) {
                while (symbol < 0x100) {
                    symbol = (symbol << 1) | rangeDecoder.decodeBit(this._decoders, symbol);
                }
                break;
            }
        } while (symbol < 0x100);

        return symbol & 0xff;
    };

    LiteralDecoder.prototype.create = function (numPosBits, numPrevBits) {
        var i;

        if (this._coders &&
            (this._numPrevBits === numPrevBits) &&
            (this._numPosBits === numPosBits)) {
            return;
        }
        this._numPosBits = numPosBits;
        this._posMask = (1 << numPosBits) - 1;
        this._numPrevBits = numPrevBits;

        this._coders = [];

        i = 1 << (this._numPrevBits + this._numPosBits);
        while (i--) {
            this._coders[i] = new LiteralDecoder.Decoder2();
        }
    };

    LiteralDecoder.prototype.init = function () {
        var i = 1 << (this._numPrevBits + this._numPosBits);
        while (i--) {
            this._coders[i].init();
        }
    };

    LiteralDecoder.prototype.getDecoder = function (pos, prevByte) {
        return this._coders[((pos & this._posMask) << this._numPrevBits) +
            ((prevByte & 0xff) >>> (8 - this._numPrevBits))];
    };

    var Decoder = function () {
        var i;
        this._outWindow = new LZ.OutWindow();
        this._rangeDecoder = new RangeCoder.Decoder();

        this._isMatchDecoders =
            initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);
        this._isRepDecoders = initBitModels(null, Base.kNumStates);
        this._isRepG0Decoders = initBitModels(null, Base.kNumStates);
        this._isRepG1Decoders = initBitModels(null, Base.kNumStates);
        this._isRepG2Decoders = initBitModels(null, Base.kNumStates);
        this._isRep0LongDecoders =
            initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);
        this._posSlotDecoder = [];
        this._posDecoders = initBitModels(null, Base.kNumFullDistances - Base.kEndPosModelIndex);
        this._posAlignDecoder = new RangeCoder.BitTreeDecoder(Base.kNumAlignBits);
        this._lenDecoder = new LenDecoder();
        this._repLenDecoder = new LenDecoder();
        this._literalDecoder = new LiteralDecoder();
        this._dictionarySize = -1;
        this._dictionarySizeCheck = -1;
        this._posStateMask = 0;

        for (i = 0; i < Base.kNumLenToPosStates; i++) {
            this._posSlotDecoder[i] = new RangeCoder.BitTreeDecoder(Base.kNumPosSlotBits);
        }
    };

    Decoder.prototype.setDictionarySize = function (dictionarySize) {
        if (dictionarySize < 0) {
            return false;
        }
        if (this._dictionarySize !== dictionarySize) {
            this._dictionarySize = dictionarySize;
            this._dictionarySizeCheck = Math.max(this._dictionarySize, 1);
            this._outWindow.create(Math.max(this._dictionarySizeCheck, (1 << 12)));
        }
        return true;
    };

    Decoder.prototype.setLcLpPb = function (lc, lp, pb) {
        var numPosStates = 1 << pb;

        if (lc > Base.kNumLitContextBitsMax || lp > 4 || pb > Base.kNumPosStatesBitsMax) {
            return false;
        }

        this._literalDecoder.create(lp, lc);

        this._lenDecoder.create(numPosStates);
        this._repLenDecoder.create(numPosStates);
        this._posStateMask = numPosStates - 1;

        return true;
    };

    Decoder.prototype.init = function () {
        var i = Base.kNumLenToPosStates;

        this._outWindow.init(false);

        initBitModels(this._isMatchDecoders);
        initBitModels(this._isRepDecoders);
        initBitModels(this._isRepG0Decoders);
        initBitModels(this._isRepG1Decoders);
        initBitModels(this._isRepG2Decoders);
        initBitModels(this._isRep0LongDecoders);
        initBitModels(this._posDecoders);

        this._literalDecoder.init();

        while (i--) {
            this._posSlotDecoder[i].init();
        }

        this._lenDecoder.init();
        this._repLenDecoder.init();
        this._posAlignDecoder.init();
        this._rangeDecoder.init();
    };

    Decoder.prototype.code = function (inStream, outStream, outSize) {
        // note that nowPos64 is actually only 53 bits long; that sets a limit
        // on the amount of data we can decode
        var state, rep0 = 0,
            rep1 = 0,
            rep2 = 0,
            rep3 = 0,
            nowPos64 = 0,
            prevByte = 0,
            posState, decoder2, len, distance, posSlot, numDirectBits;

        this._rangeDecoder.setStream(inStream);
        this._outWindow.setStream(outStream);

        this.init();

        state = Base.stateInit();
        while (outSize < 0 || nowPos64 < outSize) {
            posState = nowPos64 & this._posStateMask;

            if (this._rangeDecoder.decodeBit(this._isMatchDecoders, (state << Base.kNumPosStatesBitsMax) + posState) === 0) {
                decoder2 = this._literalDecoder.getDecoder(nowPos64, prevByte);

                if (!Base.stateIsCharState(state)) {
                    prevByte = decoder2.decodeWithMatchByte(this._rangeDecoder, this._outWindow.getByte(rep0));
                } else {
                    prevByte = decoder2.decodeNormal(this._rangeDecoder);
                }
                this._outWindow.putByte(prevByte);
                state = Base.stateUpdateChar(state);
                nowPos64++;

            } else {

                if (this._rangeDecoder.decodeBit(this._isRepDecoders, state) === 1) {
                    len = 0;
                    if (this._rangeDecoder.decodeBit(this._isRepG0Decoders, state) === 0) {
                        if (this._rangeDecoder.decodeBit(this._isRep0LongDecoders, (state << Base.kNumPosStatesBitsMax) + posState) === 0) {
                            state = Base.stateUpdateShortRep(state);
                            len = 1;
                        }
                    } else {
                        if (this._rangeDecoder.decodeBit(this._isRepG1Decoders, state) === 0) {
                            distance = rep1;
                        } else {
                            if (this._rangeDecoder.decodeBit(this._isRepG2Decoders, state) === 0) {
                                distance = rep2;
                            } else {
                                distance = rep3;
                                rep3 = rep2;
                            }
                            rep2 = rep1;
                        }
                        rep1 = rep0;
                        rep0 = distance;
                    }
                    if (len === 0) {
                        len = Base.kMatchMinLen + this._repLenDecoder.decode(this._rangeDecoder, posState);
                        state = Base.stateUpdateRep(state);
                    }
                } else {
                    rep3 = rep2;
                    rep2 = rep1;
                    rep1 = rep0;

                    len = Base.kMatchMinLen + this._lenDecoder.decode(this._rangeDecoder, posState);
                    state = Base.stateUpdateMatch(state);

                    posSlot = this._posSlotDecoder[Base.getLenToPosState(len)].decode(this._rangeDecoder);
                    if (posSlot >= Base.kStartPosModelIndex) {

                        numDirectBits = (posSlot >> 1) - 1;
                        rep0 = (2 | (posSlot & 1)) << numDirectBits;

                        if (posSlot < Base.kEndPosModelIndex) {
                            rep0 += RangeCoder.BitTreeDecoder.reverseDecode(this._posDecoders,
                                rep0 - posSlot - 1, this._rangeDecoder, numDirectBits);
                        } else {
                            rep0 += this._rangeDecoder.decodeDirectBits(numDirectBits - Base.kNumAlignBits) << Base.kNumAlignBits;
                            rep0 += this._posAlignDecoder.reverseDecode(this._rangeDecoder);
                            if (rep0 < 0) {
                                if (rep0 === -1) {
                                    break;
                                }
                                return false;
                            }
                        }
                    } else {
                        rep0 = posSlot;
                    }
                }

                if (rep0 >= nowPos64 || rep0 >= this._dictionarySizeCheck) {
                    return false;
                }

                this._outWindow.copyBlock(rep0, len);
                nowPos64 += len;
                prevByte = this._outWindow.getByte(0);
            }
        }

        this._outWindow.flush();
        this._outWindow.releaseStream();
        this._rangeDecoder.releaseStream();

        return true;
    };

    Decoder.prototype.setDecoderProperties = function (properties) {
        var value, lc, lp, pb, dictionarySize, i, shift;

        if (properties.length < 5) {
            return false;
        }

        value = properties[0] & 0xFF;
        lc = value % 9;
        value = ~~ (value / 9);
        lp = value % 5;
        pb = ~~ (value / 5);

        if (!this.setLcLpPb(lc, lp, pb)) {
            return false;
        }

        dictionarySize = 0;
        for (i = 0, shift = 1; i < 4; i++, shift *= 256)
            dictionarySize += (properties[1 + i] & 0xFF) * shift;

        return this.setDictionarySize(dictionarySize);
    };
    Decoder.prototype.setDecoderPropertiesFromStream = function (stream) {
        var buffer = [],
            i;
        for (i = 0; i < 5; i++) {
            buffer[i] = stream.readByte();
        }
        return this.setDecoderProperties(buffer);
    };

    /* lib/LZMA/Encoder.js */

    // shortcuts
    var initBitModels = RangeCoder.Encoder.initBitModels;

    // constants
    var EMatchFinderTypeBT2 = 0;
    var EMatchFinderTypeBT4 = 1;

    var kInfinityPrice = 0xFFFFFFF;
    var kDefaultDictionaryLogSize = 22;
    var kNumFastBytesDefault = 0x20;

    var kNumOpts = 1 << 12;

    var kPropSize = 5;

    var g_FastPos = (function () {
        var g_FastPos = makeBuffer(1 << 11);
        var kFastSlots = 22;
        var c = 2;
        var slotFast;
        g_FastPos[0] = 0;
        g_FastPos[1] = 1;
        for (slotFast = 2; slotFast < kFastSlots; slotFast++) {
            var j, k = 1 << ((slotFast >> 1) - 1);
            for (j = 0; j < k; j++, c++) {
                g_FastPos[c] = slotFast;
            }
        }
        return g_FastPos;
    })();

    var getPosSlot = function (pos) {
        if (pos < (1 << 11)) {
            return g_FastPos[pos];
        }
        if (pos < (1 << 21)) {
            return g_FastPos[pos >>> 10] + 20;
        }
        return g_FastPos[pos >>> 20] + 40;
    };

    var getPosSlot2 = function (pos) {
        if (pos < (1 << 17)) {
            return g_FastPos[pos >>> 6] + 12;
        }
        if (pos < (1 << 27)) {
            return g_FastPos[pos >>> 16] + 32;
        }
        return g_FastPos[pos >>> 26] + 52;
    };

    var Encoder = function () {
        var i;
        this._state = Base.stateInit();
        this._previousByte = 0;
        this._repDistances = []; // XXX use Uint32Array?
        this._repDistances.length = Base.kNumRepDistances;

        // these fields are defined much lower in the original Java source file
        this._optimum = [];
        this._matchFinder = null;
        this._rangeEncoder = new RangeCoder.Encoder();

        this._isMatch = initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);
        this._isRep = initBitModels(null, Base.kNumStates);
        this._isRepG0 = initBitModels(null, Base.kNumStates);
        this._isRepG1 = initBitModels(null, Base.kNumStates);
        this._isRepG2 = initBitModels(null, Base.kNumStates);
        this._isRep0Long = initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);

        this._posSlotEncoder = [];

        this._posEncoders = initBitModels(null, Base.kNumFullDistances - Base.kEndPosModelIndex);

        this._posAlignEncoder = new RangeCoder.BitTreeEncoder(Base.kNumAlignBits);

        this._lenEncoder = new Encoder.LenPriceTableEncoder();
        this._repMatchLenEncoder = new Encoder.LenPriceTableEncoder();

        this._literalEncoder = new Encoder.LiteralEncoder();

        this._matchDistances = [];
        this._matchDistances.length = Base.kMatchMaxLen * 2 + 2;
        for (i = 0; i < this._matchDistances.length; i++) {
            this._matchDistances[i] = 0;
        }

        this._numFastBytes = kNumFastBytesDefault;
        this._longestMatchLength = 0;
        this._numDistancePairs = 0;

        this._additionalOffset = 0;
        this._optimumEndIndex = 0;
        this._optimumCurrentIndex = 0;

        this._longestMatchWasFound = false;

        this._posSlotPrices = [];
        this._distancesPrices = [];
        this._alignPrices = [];
        this._alignPriceCount = 0;

        this._distTableSize = kDefaultDictionaryLogSize * 2;

        this._posStateBits = 2;
        this._posStateMask = 4 - 1;
        this._numLiteralPosStateBits = 0;
        this._numLiteralContextBits = 3;

        this._dictionarySize = (1 << kDefaultDictionaryLogSize);
        this._dictionarySizePrev = 0xFFFFFFFF;
        this._numFastBytesPrev = 0xFFFFFFFF;

        // note that this is a 53-bit variable, not 64-bit.  This sets the maximum
        // encoded file size.
        this.nowPos64 = 0;
        this._finished = false;
        this._inStream = null;

        this._matchFinderType = EMatchFinderTypeBT4;
        this._writeEndMark = false;
        this._needReleaseMFStream = false;

        // ...and even further down we find these:
        this.reps = [];
        this.repLens = [];
        this.backRes = 0;

        // ...keep going, eventually we find the constructor:
        for (i = 0; i < kNumOpts; i++) {
            this._optimum[i] = new Encoder.Optimal();
        }
        for (i = 0; i < Base.kNumLenToPosStates; i++) {
            this._posSlotEncoder[i] = new RangeCoder.BitTreeEncoder(Base.kNumPosSlotBits);
        }

        this._matchPriceCount = 0;

        // ...and just above the 'Code' method, we find:
        this.processedInSize = [0];
        this.processedOutSize = [0];
        this.finished = [false];
    };
    Encoder.prototype.baseInit = function () {
        var i;
        this._state = Base.stateInit();
        this._previousByte = 0;
        for (i = 0; i < Base.kNumRepDistances; i++) {
            this._repDistances[i] = 0;
        }
    };

    var LiteralEncoder = Encoder.LiteralEncoder = function () {
        this._coders = null;
        this._numPrevBits = -1;
        this._numPosBits = -1;
        this._posMask = 0;
    };

    LiteralEncoder.Encoder2 = function () {
        this._encoders = initBitModels(null, 0x300);
    };

    LiteralEncoder.Encoder2.prototype.init = function () {
        initBitModels(this._encoders);
    };

    LiteralEncoder.Encoder2.prototype.encode = function (rangeEncoder, symbol) {
        var context = 1,
            i;
        for (i = 7; i >= 0; i--) {
            var bit = (symbol >>> i) & 1;
            rangeEncoder.encode(this._encoders, context, bit);
            context = (context << 1) | bit;
        }
    };

    LiteralEncoder.Encoder2.prototype.encodeMatched = function (rangeEncoder, matchByte, symbol) {
        var context = 1,
            same = true,
            i;
        for (i = 7; i >= 0; i--) {
            var bit = (symbol >> i) & 1;
            var state = context;
            if (same) {
                var matchBit = (matchByte >>> i) & 1;
                state += (1 + matchBit) << 8;
                same = (matchBit === bit);
            }
            rangeEncoder.encode(this._encoders, state, bit);
            context = (context << 1) | bit;
        }
    };

    LiteralEncoder.Encoder2.prototype.getPrice = function (matchMode, matchByte, symbol) {
        var price = 0;
        var context = 1;
        var i = 7;
        var bit, matchBit;
        if (matchMode) {
            for (; i >= 0; i--) {
                matchBit = (matchByte >>> i) & 1;
                bit = (symbol >>> i) & 1;
                price += RangeCoder.Encoder.getPrice(this._encoders[((1 + matchBit) << 8) + context], bit);
                context = (context << 1) | bit;
                if (matchBit !== bit) {
                    i--;
                    break;
                }
            }
        }
        for (; i >= 0; i--) {
            bit = (symbol >>> i) & 1;
            price += RangeCoder.Encoder.getPrice(this._encoders[context], bit);
            context = (context << 1) | bit;
        }
        return price;
    };

    LiteralEncoder.prototype.create = function (numPosBits, numPrevBits) {
        var i;
        if (this._coders &&
            this._numPrevBits === numPrevBits &&
            this._numPosBits === numPosBits) {
            return;
        }

        this._numPosBits = numPosBits;
        this._posMask = (1 << numPosBits) - 1;
        this._numPrevBits = numPrevBits;
        var numStates = 1 << (this._numPrevBits + this._numPosBits);
        this._coders = [];
        for (i = 0; i < numStates; i++) {
            this._coders[i] = new LiteralEncoder.Encoder2();
        }
    };

    LiteralEncoder.prototype.init = function () {
        var numStates = 1 << (this._numPrevBits + this._numPosBits),
            i;
        for (i = 0; i < numStates; i++) {
            this._coders[i].init();
        }
    };

    LiteralEncoder.prototype.getSubCoder = function (pos, prevByte) {
        return this._coders[((pos & this._posMask) << this._numPrevBits) + (prevByte >> (8 - this._numPrevBits))];
    };

    var LenEncoder = Encoder.LenEncoder = function () {
        var posState;
        this._choice = initBitModels(null, 2);
        this._lowCoder = [];
        this._midCoder = [];
        this._highCoder = new RangeCoder.BitTreeEncoder(Base.kNumHighLenBits);

        for (posState = 0; posState < Base.kNumPosStatesEncodingMax; posState++) {
            this._lowCoder[posState] = new RangeCoder.BitTreeEncoder(Base.kNumLowLenBits);
            this._midCoder[posState] = new RangeCoder.BitTreeEncoder(Base.kNumMidLenBits);
        }
    };

    LenEncoder.prototype.init = function (numPosStates) {
        var posState;
        initBitModels(this._choice);
        for (posState = 0; posState < numPosStates; posState++) {
            this._lowCoder[posState].init();
            this._midCoder[posState].init();
        }
        this._highCoder.init();
    };

    LenEncoder.prototype.encode = function (rangeEncoder, symbol, posState) {
        if (symbol < Base.kNumLowLenSymbols) {
            rangeEncoder.encode(this._choice, 0, 0);
            this._lowCoder[posState].encode(rangeEncoder, symbol);
        } else {
            symbol -= Base.kNumLowLenSymbols;
            rangeEncoder.encode(this._choice, 0, 1);
            if (symbol < Base.kNumMidLenSymbols) {
                rangeEncoder.encode(this._choice, 1, 0);
                this._midCoder[posState].encode(rangeEncoder, symbol);
            } else {
                rangeEncoder.encode(this._choice, 1, 1);
                this._highCoder.encode(rangeEncoder, symbol - Base.kNumMidLenSymbols);
            }
        }
    };

    LenEncoder.prototype.setPrices = function (posState, numSymbols, prices, st) {
        var a0 = RangeCoder.Encoder.getPrice0(this._choice[0]);
        var a1 = RangeCoder.Encoder.getPrice1(this._choice[0]);
        var b0 = a1 + RangeCoder.Encoder.getPrice0(this._choice[1]);
        var b1 = a1 + RangeCoder.Encoder.getPrice1(this._choice[1]);
        var i;
        for (i = 0; i < Base.kNumLowLenSymbols; i++) {
            if (i >= numSymbols) {
                return;
            }
            prices[st + i] = a0 + this._lowCoder[posState].getPrice(i);
        }
        for (; i < Base.kNumLowLenSymbols + Base.kNumMidLenSymbols; i++) {
            if (i >= numSymbols) {
                return;
            }
            prices[st + i] = b0 + this._midCoder[posState].getPrice(i - Base.kNumLowLenSymbols);
        }
        for (; i < numSymbols; i++) {
            prices[st + i] = b1 + this._highCoder.getPrice(i - Base.kNumLowLenSymbols - Base.kNumMidLenSymbols);
        }
    };

    var kNumLenSpecSymbols = Base.kNumLowLenSymbols + Base.kNumMidLenSymbols;

    var LenPriceTableEncoder = Encoder.LenPriceTableEncoder = function () {
        LenEncoder.call(this); // superclass constructor
        this._prices = [];
        this._counters = [];
        this._tableSize = 0;
    };
    LenPriceTableEncoder.prototype = Object.create(LenEncoder.prototype);
    LenPriceTableEncoder.prototype.setTableSize = function (tableSize) {
        this._tableSize = tableSize;
    };
    LenPriceTableEncoder.prototype.getPrice = function (symbol, posState) {
        return this._prices[posState * Base.kNumLenSymbols + symbol];
    };
    LenPriceTableEncoder.prototype.updateTable = function (posState) {
        this.setPrices(posState, this._tableSize, this._prices,
            posState * Base.kNumLenSymbols);
        this._counters[posState] = this._tableSize;
    };
    LenPriceTableEncoder.prototype.updateTables = function (numPosStates) {
        var posState;
        for (posState = 0; posState < numPosStates; posState++) {
            this.updateTable(posState);
        }
    };
    LenPriceTableEncoder.prototype.encode = (function (superEncode) {
        return function (rangeEncoder, symbol, posState) {
            superEncode.call(this, rangeEncoder, symbol, posState);
            if (--this._counters[posState] === 0) {
                this.updateTable(posState);
            }
        };
    })(LenPriceTableEncoder.prototype.encode);

    var Optimal = Encoder.Optimal = function () {
        this.state = 0;

        this.prev1IsChar = false;
        this.prev2 = false;

        this.posPrev2 = 0;
        this.backPrev2 = 0;

        this.price = 0;
        this.posPrev = 0;
        this.backPrev = 0;

        this.backs0 = 0;
        this.backs1 = 0;
        this.backs2 = 0;
        this.backs3 = 0;
    };
    Optimal.prototype.makeAsChar = function () {
        this.backPrev = -1;
        this.prev1IsChar = false;
    };
    Optimal.prototype.makeAsShortRep = function () {
        this.backPrev = 0;
        this.prev1IsChar = false;
    };
    Optimal.prototype.isShortRep = function () {
        return this.backPrev === 0;
    };

    // back to the Encoder class!
    Encoder.prototype.create = function () {
        var numHashBytes;
        if (!this._matchFinder) {
            var bt = new LZ.BinTree();
            numHashBytes = 4;
            if (this._matchFinderType === EMatchFinderTypeBT2) {
                numHashBytes = 2;
            }
            bt.setType(numHashBytes);
            this._matchFinder = bt;
        }
        this._literalEncoder.create(this._numLiteralPosStateBits,
            this._numLiteralContextBits);

        if (this._dictionarySize === this._dictionarySizePrev &&
            this._numFastBytesPrev === this._numFastBytes) {
            return;
        }
        this._matchFinder.create(this._dictionarySize, kNumOpts, this._numFastBytes,
            Base.kMatchMaxLen + 1);
        this._dictionarySizePrev = this._dictionarySize;
        this._numFastBytesPrev = this._numFastBytes;
    };

    Encoder.prototype.setWriteEndMarkerMode = function (writeEndMarker) {
        this._writeEndMark = writeEndMarker;
    };

    Encoder.prototype.init = function () {
        var i;
        this.baseInit();
        this._rangeEncoder.init();

        initBitModels(this._isMatch);
        initBitModels(this._isRep0Long);
        initBitModels(this._isRep);
        initBitModels(this._isRepG0);
        initBitModels(this._isRepG1);
        initBitModels(this._isRepG2);
        initBitModels(this._posEncoders);

        this._literalEncoder.init();
        for (i = 0; i < Base.kNumLenToPosStates; i++) {
            this._posSlotEncoder[i].init();
        }

        this._lenEncoder.init(1 << this._posStateBits);
        this._repMatchLenEncoder.init(1 << this._posStateBits);

        this._posAlignEncoder.init();

        this._longestMatchWasFound = false;
        this._optimumEndIndex = 0;
        this._optimumCurrentIndex = 0;
        this._additionalOffset = 0;
    };

    Encoder.prototype.readMatchDistances = function () {
        var lenRes = 0;
        this._numDistancePairs = this._matchFinder.getMatches(this._matchDistances);
        if (this._numDistancePairs > 0) {
            lenRes = this._matchDistances[this._numDistancePairs - 2];
            if (lenRes === this._numFastBytes) {
                lenRes += this._matchFinder.getMatchLen(lenRes - 1, this._matchDistances[this._numDistancePairs - 1], Base.kMatchMaxLen - lenRes);
            }
        }
        this._additionalOffset++;
        // [csa] Gary Linscott thinks that numDistancePairs should be a retval here.
        return lenRes;
    };

    Encoder.prototype.movePos = function (num) {
        if (num > 0) {
            this._matchFinder.skip(num);
            this._additionalOffset += num;
        }
    };

    Encoder.prototype.getRepLen1Price = function (state, posState) {
        return RangeCoder.Encoder.getPrice0(this._isRepG0[state]) +
            RangeCoder.Encoder.getPrice0(this._isRep0Long[(state << Base.kNumPosStatesBitsMax) + posState]);
    };

    Encoder.prototype.getPureRepPrice = function (repIndex, state, posState) {
        var price;
        if (repIndex === 0) {
            price = RangeCoder.Encoder.getPrice0(this._isRepG0[state]);
            price += RangeCoder.Encoder.getPrice1(this._isRep0Long[(state << Base.kNumPosStatesBitsMax) + posState]);
        } else {
            price = RangeCoder.Encoder.getPrice1(this._isRepG0[state]);
            if (repIndex === 1) {
                price += RangeCoder.Encoder.getPrice0(this._isRepG1[state]);
            } else {
                price += RangeCoder.Encoder.getPrice1(this._isRepG1[state]);
                price += RangeCoder.Encoder.getPrice(this._isRepG2[state], repIndex - 2);
            }
        }
        return price;
    };

    Encoder.prototype.getRepPrice = function (repIndex, len, state, posState) {
        var price = this._repMatchLenEncoder.getPrice(len - Base.kMatchMinLen, posState);
        return price + this.getPureRepPrice(repIndex, state, posState);
    };

    Encoder.prototype.getPosLenPrice = function (pos, len, posState) {
        var price;
        var lenToPosState = Base.getLenToPosState(len);
        if (pos < Base.kNumFullDistances) {
            price = this._distancesPrices[(lenToPosState * Base.kNumFullDistances) + pos];
        } else {
            price = this._posSlotPrices[(lenToPosState << Base.kNumPosSlotBits) + getPosSlot2(pos)] + this._alignPrices[pos & Base.kAlignMask];
        }
        return price + this._lenEncoder.getPrice(len - Base.kMatchMinLen, posState);
    };

    Encoder.prototype.backward = function (cur) {
        this._optimumEndIndex = cur;
        var posMem = this._optimum[cur].posPrev;
        var backMem = this._optimum[cur].backPrev;
        do {
            if (this._optimum[cur].prev1IsChar) {
                this._optimum[posMem].makeAsChar();
                this._optimum[posMem].posPrev = posMem - 1;
                if (this._optimum[cur].prev2) {
                    this._optimum[posMem - 1].prev1IsChar = false;
                    this._optimum[posMem - 1].posPrev = this._optimum[cur].posPrev2;
                    this._optimum[posMem - 1].backPrev = this._optimum[cur].backPrev2;
                }
            }
            var posPrev = posMem;
            var backCur = backMem;

            backMem = this._optimum[posPrev].backPrev;
            posMem = this._optimum[posPrev].posPrev;

            this._optimum[posPrev].backPrev = backCur;
            this._optimum[posPrev].posPrev = cur;
            cur = posPrev;
        } while (cur > 0);

        this.backRes = this._optimum[0].backPrev;
        this._optimumCurrentIndex = this._optimum[0].posPrev;
        // [csa] Gary Linscott thinks that backRes should be a retval here.
        return this._optimumCurrentIndex;
    };

    Encoder.prototype.getOptimum = function (position) {

        if (this._optimumEndIndex !== this._optimumCurrentIndex) {
            var lenRes = this._optimum[this._optimumCurrentIndex].posPrev - this._optimumCurrentIndex;
            this.backRes = this._optimum[this._optimumCurrentIndex].backPrev;
            this._optimumCurrentIndex = this._optimum[this._optimumCurrentIndex].posPrev;
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            return lenRes;
        }
        this._optimumCurrentIndex = this._optimumEndIndex = 0;

        var lenMain;
        if (!this._longestMatchWasFound) {
            lenMain = this.readMatchDistances();
        } else {
            lenMain = this._longestMatchLength;
            this._longestMatchWasFound = false;
        }
        var numDistancePairs = this._numDistancePairs;

        var numAvailableBytes = this._matchFinder.getNumAvailableBytes() + 1;
        if (numAvailableBytes < 2) {
            this.backRes = -1;
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            return 1;
        }
        if (numAvailableBytes > Base.kMatchMaxLen) {
            numAvailableBytes = Base.kMatchMaxLen;
        }

        var repMaxIndex = 0,
            i;
        for (i = 0; i < Base.kNumRepDistances; i++) {
            this.reps[i] = this._repDistances[i];
            this.repLens[i] = this._matchFinder.getMatchLen(-1, this.reps[i], Base.kMatchMaxLen);
            if (this.repLens[i] > this.repLens[repMaxIndex]) {
                repMaxIndex = i;
            }
        }
        if (this.repLens[repMaxIndex] >= this._numFastBytes) {
            this.backRes = repMaxIndex;
            var lenRes2 = this.repLens[repMaxIndex];
            this.movePos(lenRes2 - 1);
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            return lenRes2;
        }

        if (lenMain >= this._numFastBytes) {
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            this.backRes = this._matchDistances[numDistancePairs - 1] + Base.kNumRepDistances;
            this.movePos(lenMain - 1);
            return lenMain;
        }

        var currentByte = this._matchFinder.getIndexByte(-1);
        var matchByte = this._matchFinder.getIndexByte(-this._repDistances[0] - 2);

        if (lenMain < 2 && currentByte !== matchByte && this.repLens[repMaxIndex] < 2) {
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            this.backRes = -1;
            return 1;
        }

        this._optimum[0].state = this._state;

        var posState = position & this._posStateMask;

        this._optimum[1].price = RangeCoder.Encoder.getPrice0(this._isMatch[(this._state << Base.kNumPosStatesBitsMax) + posState]) +
            this._literalEncoder.getSubCoder(position, this._previousByte).getPrice(!Base.stateIsCharState(this._state), matchByte, currentByte);
        this._optimum[1].makeAsChar();

        var matchPrice = RangeCoder.Encoder.getPrice1(this._isMatch[(this._state << Base.kNumPosStatesBitsMax) + posState]);
        var repMatchPrice = matchPrice + RangeCoder.Encoder.getPrice1(this._isRep[this._state]);

        if (matchByte === currentByte) {
            var shortRepPrice = repMatchPrice + this.getRepLen1Price(this._state, posState);
            if (shortRepPrice < this._optimum[1].price) {
                this._optimum[1].price = shortRepPrice;
                this._optimum[1].makeAsShortRep();
            }
        }

        var lenEnd = (lenMain >= this.repLens[repMaxIndex]) ?
            lenMain : this.repLens[repMaxIndex];
        if (lenEnd < 2) {
            // [csa] Gary Linscott thinks that backRes should be a retval here.
            this.backRes = this._optimum[1].backPrev;
            return 1;
        }

        this._optimum[1].posPrev = 0;

        this._optimum[0].backs0 = this.reps[0];
        this._optimum[0].backs1 = this.reps[1];
        this._optimum[0].backs2 = this.reps[2];
        this._optimum[0].backs3 = this.reps[3];

        var len = lenEnd;
        do {
            this._optimum[len--].price = kInfinityPrice;
        } while (len >= 2);

        for (i = 0; i < Base.kNumRepDistances; i++) {
            var repLen = this.repLens[i];
            if (repLen < 2) {
                continue;
            }
            var price = repMatchPrice + this.getPureRepPrice(i, this._state, posState);
            do {
                var curAndLenPrice = price +
                    this._repMatchLenEncoder.getPrice(repLen - 2, posState);
                var optimum = this._optimum[repLen];
                if (curAndLenPrice < optimum.price) {
                    optimum.price = curAndLenPrice;
                    optimum.posPrev = 0;
                    optimum.backPrev = i;
                    optimum.prev1IsChar = false;
                }
            } while (--repLen >= 2);
        }

        var normalMatchPrice = matchPrice +
            RangeCoder.Encoder.getPrice0(this._isRep[this._state]);

        len = this.repLens[0] >= 2 ? this.repLens[0] + 1 : 2;
        if (len <= lenMain) {
            var offs = 0;
            while (len > this._matchDistances[offs]) {
                offs += 2;
            }
            for (;; len++) {
                var distance = this._matchDistances[offs + 1];
                var curAndLenPrice2 = normalMatchPrice +
                    this.getPosLenPrice(distance, len, posState);
                var optimum2 = this._optimum[len];
                if (curAndLenPrice2 < optimum2.price) {
                    optimum2.price = curAndLenPrice2;
                    optimum2.posPrev = 0;
                    optimum2.backPrev = distance + Base.kNumRepDistances;
                    optimum2.prev1IsChar = false;
                }
                if (len === this._matchDistances[offs]) {
                    offs += 2;
                    if (offs === numDistancePairs) {
                        break;
                    }
                }
            }
        }

        var cur = 0;
        while (true) {
            cur++;
            if (cur === lenEnd) {
                return this.backward(cur);
            }
            var newLen = this.readMatchDistances();
            numDistancePairs = this._numDistancePairs;
            if (newLen >= this._numFastBytes) {
                this._longestMatchLength = newLen;
                this._longestMatchWasFound = true;
                return this.backward(cur);
            }
            position++;
            var posPrev = this._optimum[cur].posPrev;
            var state;
            if (this._optimum[cur].prev1IsChar) {
                posPrev--;
                if (this._optimum[cur].prev2) {
                    state = this._optimum[this._optimum[cur].posPrev2].state;
                    if (this._optimum[cur].backPrev2 < Base.kNumRepDistances) {
                        state = Base.stateUpdateRep(state);
                    } else {
                        state = Base.stateUpdateMatch(state);
                    }
                } else {
                    state = this._optimum[posPrev].state;
                }
                state = Base.stateUpdateChar(state);
            } else {
                state = this._optimum[posPrev].state;
            }
            if (posPrev === cur - 1) {
                if (this._optimum[cur].isShortRep()) {
                    state = Base.stateUpdateShortRep(state);
                } else {
                    state = Base.stateUpdateChar(state);
                }
            } else {
                var pos;
                if (this._optimum[cur].prev1IsChar && this._optimum[cur].prev2) {
                    posPrev = this._optimum[cur].posPrev2;
                    pos = this._optimum[cur].backPrev2;
                    state = Base.stateUpdateRep(state);
                } else {
                    pos = this._optimum[cur].backPrev;
                    if (pos < Base.kNumRepDistances) {
                        state = Base.stateUpdateRep(state);
                    } else {
                        state = Base.stateUpdateMatch(state);
                    }
                }

                var opt = this._optimum[posPrev];
                if (pos < Base.kNumRepDistances) {
                    if (pos === 0) {
                        this.reps[0] = opt.backs0;
                        this.reps[1] = opt.backs1;
                        this.reps[2] = opt.backs2;
                        this.reps[3] = opt.backs3;
                    } else if (pos === 1) {
                        this.reps[0] = opt.backs1;
                        this.reps[1] = opt.backs0;
                        this.reps[2] = opt.backs2;
                        this.reps[3] = opt.backs3;
                    } else if (pos === 2) {
                        this.reps[0] = opt.backs2;
                        this.reps[1] = opt.backs0;
                        this.reps[2] = opt.backs1;
                        this.reps[3] = opt.backs3;
                    } else {
                        this.reps[0] = opt.backs3;
                        this.reps[1] = opt.backs0;
                        this.reps[2] = opt.backs1;
                        this.reps[3] = opt.backs2;
                    }
                } else {
                    this.reps[0] = pos - Base.kNumRepDistances;
                    this.reps[1] = opt.backs0;
                    this.reps[2] = opt.backs1;
                    this.reps[3] = opt.backs2;
                }
            }
            this._optimum[cur].state = state;
            this._optimum[cur].backs0 = this.reps[0];
            this._optimum[cur].backs1 = this.reps[1];
            this._optimum[cur].backs2 = this.reps[2];
            this._optimum[cur].backs3 = this.reps[3];
            var curPrice = this._optimum[cur].price;

            currentByte = this._matchFinder.getIndexByte(-1);
            matchByte = this._matchFinder.getIndexByte(-this.reps[0] - 2);
            posState = position & this._posStateMask;

            var curAnd1Price = curPrice +
                RangeCoder.Encoder.getPrice0(this._isMatch[(state << Base.kNumPosStatesBitsMax) + posState]) +
                this._literalEncoder.getSubCoder(position, this._matchFinder.getIndexByte(-2)).
            getPrice(!Base.stateIsCharState(state), matchByte, currentByte);

            var nextOptimum = this._optimum[cur + 1];

            var nextIsChar = false;
            if (curAnd1Price < nextOptimum.price) {
                nextOptimum.price = curAnd1Price;
                nextOptimum.posPrev = cur;
                nextOptimum.makeAsChar();
                nextIsChar = true;
            }

            matchPrice = curPrice + RangeCoder.Encoder.getPrice1(this._isMatch[(state << Base.kNumPosStatesBitsMax) + posState]);
            repMatchPrice = matchPrice + RangeCoder.Encoder.getPrice1(this._isRep[state]);

            if (matchByte === currentByte &&
                !(nextOptimum.posPrev < cur && nextOptimum.backPrev === 0)) {
                var shortRepPrice2 =
                    repMatchPrice + this.getRepLen1Price(state, posState);
                if (shortRepPrice2 <= nextOptimum.price) {
                    nextOptimum.price = shortRepPrice2;
                    nextOptimum.posPrev = cur;
                    nextOptimum.makeAsShortRep();
                    nextIsChar = true;
                }
            }

            var numAvailableBytesFull = this._matchFinder.getNumAvailableBytes() + 1;
            numAvailableBytesFull = Math.min(kNumOpts - 1 - cur, numAvailableBytesFull);
            numAvailableBytes = numAvailableBytesFull;

            if (numAvailableBytes < 2) {
                continue;
            }
            if (numAvailableBytes > this._numFastBytes) {
                numAvailableBytes = this._numFastBytes;
            }
            if (!nextIsChar && matchByte !== currentByte) {
                // Try Literal + rep0
                var t = Math.min(numAvailableBytesFull - 1, this._numFastBytes);
                var lenTest2 = this._matchFinder.getMatchLen(0, this.reps[0], t);
                if (lenTest2 >= 2) {
                    var state2 = Base.stateUpdateChar(state);

                    var posStateNext = (position + 1) & this._posStateMask;
                    var nextRepMatchPrice = curAnd1Price +
                        RangeCoder.Encoder.getPrice1(this._isMatch[(state2 << Base.kNumPosStatesBitsMax) + posStateNext]) +
                        RangeCoder.Encoder.getPrice1(this._isRep[state2]);

                    var offset = cur + 1 + lenTest2;
                    while (lenEnd < offset) {
                        this._optimum[++lenEnd].price = kInfinityPrice;
                    }
                    var curAndLenPrice3 = nextRepMatchPrice + this.getRepPrice(0, lenTest2, state2, posStateNext);
                    var optimum3 = this._optimum[offset];
                    if (curAndLenPrice3 < optimum3.price) {
                        optimum3.price = curAndLenPrice3;
                        optimum3.posPrev = cur + 1;
                        optimum3.backPrev = 0;
                        optimum3.prev1IsChar = true;
                        optimum3.prev2 = false;
                    }
                }
            }

            var startLen = 2; // Speed optimization

            var repIndex;
            for (repIndex = 0; repIndex < Base.kNumRepDistances; repIndex++) {
                var lenTest = this._matchFinder.getMatchLen(-1, this.reps[repIndex], numAvailableBytes);
                if (lenTest < 2) {
                    continue;
                }
                var lenTestTemp = lenTest;
                do {
                    while (lenEnd < cur + lenTest) {
                        this._optimum[++lenEnd].price = kInfinityPrice;
                    }
                    var curAndLenPrice4 = repMatchPrice + this.getRepPrice(repIndex, lenTest, state, posState);
                    var optimum4 = this._optimum[cur + lenTest];
                    if (curAndLenPrice4 < optimum4.price) {
                        optimum4.price = curAndLenPrice4;
                        optimum4.posPrev = cur;
                        optimum4.backPrev = repIndex;
                        optimum4.prev1IsChar = false;
                    }
                } while (--lenTest >= 2);
                lenTest = lenTestTemp;

                if (repIndex === 0) {
                    startLen = lenTest + 1;
                }

                // if (_maxMode)
                if (lenTest < numAvailableBytesFull) {
                    var t5 = Math.min(numAvailableBytesFull - 1 - lenTest, this._numFastBytes);
                    var lenTest25 = this._matchFinder.getMatchLen(lenTest, this.reps[repIndex], t5);
                    if (lenTest25 >= 2) {
                        var state25 = Base.stateUpdateRep(state);
                        var posStateNext5 = (position + lenTest) & this._posStateMask;
                        var curAndLenCharPrice = repMatchPrice +
                            this.getRepPrice(repIndex, lenTest, state, posState) +
                            RangeCoder.Encoder.getPrice0(this._isMatch[(state25 << Base.kNumPosStatesBitsMax) + posStateNext5]) +
                            this._literalEncoder.getSubCoder(position + lenTest,
                                this._matchFinder.getIndexByte(lenTest - 2)).
                        getPrice(true,
                            this._matchFinder.getIndexByte(lenTest - 1 - (this.reps[repIndex] + 1)),
                            this._matchFinder.getIndexByte(lenTest - 1));

                        state25 = Base.stateUpdateChar(state25);
                        posStateNext5 = (position + lenTest + 1) & this._posStateMask;
                        var nextMatchPrice5 = curAndLenCharPrice +
                            RangeCoder.Encoder.getPrice1(this._isMatch[(state25 << Base.kNumPosStatesBitsMax) + posStateNext5]);
                        var nextRepMatchPrice5 = nextMatchPrice5 +
                            RangeCoder.Encoder.getPrice1(this._isRep[state25]);

                        // for(; lenTest2 >= 2; lenTest2--) {
                        var offset5 = lenTest + 1 + lenTest25;
                        while (lenEnd < cur + offset5) {
                            this._optimum[++lenEnd].price = kInfinityPrice;
                        }
                        var curAndLenPrice5 = nextRepMatchPrice5 +
                            this.getRepPrice(0, lenTest25, state25, posStateNext5);
                        var optimum5 = this._optimum[cur + offset5];
                        if (curAndLenPrice5 < optimum5.price) {
                            optimum5.price = curAndLenPrice5;
                            optimum5.posPrev = cur + lenTest + 1;
                            optimum5.backPrev = 0;
                            optimum5.prev1IsChar = true;
                            optimum5.prev2 = true;
                            optimum5.posPrev2 = cur;
                            optimum5.backPrev2 = repIndex;
                        }
                    }
                }
            }

            if (newLen > numAvailableBytes) {
                newLen = numAvailableBytes;
                numDistancePairs = 0;
                while (newLen > this._matchDistances[numDistancePairs]) {
                    numDistancePairs += 2;
                }
                this._matchDistances[numDistancePairs] = newLen;
                numDistancePairs += 2;
            }
            if (newLen >= startLen) {
                normalMatchPrice = matchPrice +
                    RangeCoder.Encoder.getPrice0(this._isRep[state]);
                while (lenEnd < cur + newLen) {
                    this._optimum[++lenEnd].price = kInfinityPrice;
                }

                var offs6 = 0;
                while (startLen > this._matchDistances[offs6]) {
                    offs6 += 2;
                }

                var lenTest6;
                for (lenTest6 = startLen;; lenTest6++) {
                    var curBack = this._matchDistances[offs6 + 1];
                    var curAndLenPrice6 = normalMatchPrice +
                        this.getPosLenPrice(curBack, lenTest6, posState);
                    var optimum6 = this._optimum[cur + lenTest6];
                    if (curAndLenPrice6 < optimum6.price) {
                        optimum6.price = curAndLenPrice6;
                        optimum6.posPrev = cur;
                        optimum6.backPrev = curBack + Base.kNumRepDistances;
                        optimum6.prev1IsChar = false;
                    }

                    if (lenTest6 === this._matchDistances[offs6]) {
                        if (lenTest6 < numAvailableBytesFull) {
                            var t7 = Math.min(numAvailableBytesFull - 1 - lenTest6,
                                this._numFastBytes);
                            var lenTest27 = this._matchFinder.getMatchLen(lenTest6, curBack, t7);
                            if (lenTest27 >= 2) {
                                var state27 = Base.stateUpdateMatch(state);

                                var posStateNext7 = (position + lenTest6) & this._posStateMask;
                                var curAndLenCharPrice7 = curAndLenPrice6 +
                                    RangeCoder.Encoder.getPrice0(this._isMatch[(state27 << Base.kNumPosStatesBitsMax) + posStateNext7]) +
                                    this._literalEncoder.getSubCoder(position + lenTest6,
                                        this._matchFinder.getIndexByte(lenTest6 - 2)).
                                getPrice(true,
                                    this._matchFinder.getIndexByte(lenTest6 - (curBack + 1) - 1),
                                    this._matchFinder.getIndexByte(lenTest6 - 1));
                                state27 = Base.stateUpdateChar(state27);
                                posStateNext7 = (position + lenTest6 + 1) & this._posStateMask;
                                var nextMatchPrice7 = curAndLenCharPrice7 +
                                    RangeCoder.Encoder.getPrice1(this._isMatch[(state27 << Base.kNumPosStatesBitsMax) + posStateNext7]);
                                var nextRepMatchPrice7 = nextMatchPrice7 +
                                    RangeCoder.Encoder.getPrice1(this._isRep[state27]);

                                var offset7 = lenTest6 + 1 + lenTest27;
                                while (lenEnd < cur + offset7) {
                                    this._optimum[++lenEnd].price = kInfinityPrice;
                                }
                                var curAndLenPrice7 = nextRepMatchPrice7 +
                                    this.getRepPrice(0, lenTest27, state27, posStateNext7);
                                var optimum7 = this._optimum[cur + offset7];
                                if (curAndLenPrice7 < optimum7.price) {
                                    optimum7.price = curAndLenPrice7;
                                    optimum7.posPrev = cur + lenTest6 + 1;
                                    optimum7.backPrev = 0;
                                    optimum7.prev1IsChar = true;
                                    optimum7.prev2 = true;
                                    optimum7.posPrev2 = cur;
                                    optimum7.backPrev2 = curBack + Base.kNumRepDistances;
                                }
                            }
                        }
                        offs6 += 2;
                        if (offs6 === numDistancePairs) {
                            break;
                        }
                    }
                }
            }
        }
    };

    Encoder.prototype.changePair = function (smallDist, bigDist) {
        var kDif = 7;
        return (smallDist < (1 << (32 - kDif)) && bigDist >= (smallDist << kDif));
    };

    Encoder.prototype.writeEndMarker = function (posState) {
        if (!this._writeEndMark) {
            return;
        }

        this._rangeEncoder.encode(this._isMatch, (this._state << Base.kNumPosStatesBitsMax) + posState, 1);
        this._rangeEncoder.encode(this._isRep, this._state, 0);
        this._state = Base.stateUpdateMatch(this._state);
        var len = Base.kMatchMinLen;
        this._lenEncoder.encode(this._rangeEncoder, len - Base.kMatchMinLen, posState);
        var posSlot = (1 << Base.kNumPosSlotBits) - 1;
        var lenToPosState = Base.getLenToPosState(len);
        this._posSlotEncoder[lenToPosState].encode(this._rangeEncoder, posSlot);
        var footerBits = 30;
        var posReduced = (1 << footerBits) - 1;
        this._rangeEncoder.encodeDirectBits(posReduced >> Base.kNumAlignBits,
            footerBits - Base.kNumAlignBits);
        this._posAlignEncoder.reverseEncode(this._rangeEncoder,
            posReduced & Base.kAlignMask);
    };

    Encoder.prototype.flush = function (nowPos) {
        this.releaseMFStream();
        this.writeEndMarker(nowPos & this._posStateMask);
        this._rangeEncoder.flushData();
        this._rangeEncoder.flushStream();
    };

    Encoder.prototype.codeOneBlock = function (inSize, outSize, finished) {
        inSize[0] = 0;
        outSize[0] = 0;
        finished[0] = true;

        if (this._inStream) {
            this._matchFinder.setStream(this._inStream);
            this._matchFinder.init();
            this._needReleaseMFStream = true;
            this._inStream = null;
        }

        if (this._finished) {
            return;
        }
        this._finished = true;

        var progressPosValuePrev = this.nowPos64;
        var posState, curByte, i;

        if (this.nowPos64 === 0) {
            if (this._matchFinder.getNumAvailableBytes() === 0) {
                this.flush(this.nowPos64);
                return;
            }

            this.readMatchDistances();
            posState = this.nowPos64 & this._posStateMask;
            this._rangeEncoder.encode(this._isMatch, (this._state << Base.kNumPosStatesBitsMax) + posState, 0);
            this._state = Base.stateUpdateChar(this._state);
            curByte = this._matchFinder.getIndexByte(0 - this._additionalOffset);
            this._literalEncoder.getSubCoder(this.nowPos64, this._previousByte).
            encode(this._rangeEncoder, curByte);
            this._previousByte = curByte;
            this._additionalOffset--;
            this.nowPos64++;
        }
        if (this._matchFinder.getNumAvailableBytes() === 0) {
            this.flush(this.nowPos64);
            return;
        }
        while (true) {
            var len = this.getOptimum(this.nowPos64);
            var pos = this.backRes;
            posState = this.nowPos64 & this._posStateMask;
            var complexState = (this._state << Base.kNumPosStatesBitsMax) + posState;
            if (len === 1 && pos === -1) {
                this._rangeEncoder.encode(this._isMatch, complexState, 0);
                curByte = this._matchFinder.getIndexByte(-this._additionalOffset);
                var subCoder = this._literalEncoder.getSubCoder(this.nowPos64,
                    this._previousByte);
                if (!Base.stateIsCharState(this._state)) {
                    var matchByte = this._matchFinder.getIndexByte(-this._repDistances[0] - 1 - this._additionalOffset);
                    subCoder.encodeMatched(this._rangeEncoder, matchByte, curByte);
                } else {
                    subCoder.encode(this._rangeEncoder, curByte);
                }
                this._previousByte = curByte;
                this._state = Base.stateUpdateChar(this._state);
            } else {
                this._rangeEncoder.encode(this._isMatch, complexState, 1);
                if (pos < Base.kNumRepDistances) {
                    this._rangeEncoder.encode(this._isRep, this._state, 1);
                    if (pos === 0) {
                        this._rangeEncoder.encode(this._isRepG0, this._state, 0);
                        if (len === 1) {
                            this._rangeEncoder.encode(this._isRep0Long, complexState, 0);
                        } else {
                            this._rangeEncoder.encode(this._isRep0Long, complexState, 1);
                        }
                    } else {
                        this._rangeEncoder.encode(this._isRepG0, this._state, 1);
                        if (pos === 1) {
                            this._rangeEncoder.encode(this._isRepG1, this._state, 0);
                        } else {
                            this._rangeEncoder.encode(this._isRepG1, this._state, 1);
                            this._rangeEncoder.encode(this._isRepG2, this._state, pos - 2);
                        }
                    }
                    if (len === 1) {
                        this._state = Base.stateUpdateShortRep(this._state);
                    } else {
                        this._repMatchLenEncoder.encode(this._rangeEncoder,
                            len - Base.kMatchMinLen, posState);
                        this._state = Base.stateUpdateRep(this._state);
                    }
                    var distance = this._repDistances[pos];
                    if (pos !== 0) {
                        for (i = pos; i >= 1; i--) {
                            this._repDistances[i] = this._repDistances[i - 1];
                        }
                        this._repDistances[0] = distance;
                    }
                } else {
                    this._rangeEncoder.encode(this._isRep, this._state, 0);
                    this._state = Base.stateUpdateMatch(this._state);
                    this._lenEncoder.encode(this._rangeEncoder, len - Base.kMatchMinLen,
                        posState);
                    pos -= Base.kNumRepDistances;
                    var posSlot = getPosSlot(pos);
                    var lenToPosState = Base.getLenToPosState(len);
                    this._posSlotEncoder[lenToPosState].encode(this._rangeEncoder, posSlot);

                    if (posSlot >= Base.kStartPosModelIndex) {
                        var footerBits = ((posSlot >>> 1) - 1);
                        var baseVal = ((2 | (posSlot & 1)) << footerBits);
                        var posReduced = pos - baseVal;

                        if (posSlot < Base.kEndPosModelIndex) {
                            RangeCoder.BitTreeEncoder.reverseEncode(this._posEncoders,
                                baseVal - posSlot - 1,
                                this._rangeEncoder,
                                footerBits, posReduced);
                        } else {
                            this._rangeEncoder.encodeDirectBits(posReduced >> Base.kNumAlignBits, footerBits - Base.kNumAlignBits);
                            this._posAlignEncoder.reverseEncode(this._rangeEncoder,
                                posReduced & Base.kAlignMask);
                            this._alignPriceCount++;
                        }
                    }
                    var distance2 = pos;
                    for (i = Base.kNumRepDistances - 1; i >= 1; i--) {
                        this._repDistances[i] = this._repDistances[i - 1];
                    }
                    this._repDistances[0] = distance2;
                    this._matchPriceCount++;
                }
                this._previousByte =
                    this._matchFinder.getIndexByte(len - 1 - this._additionalOffset);
            }
            this._additionalOffset -= len;
            this.nowPos64 += len;
            if (this._additionalOffset === 0) {
                // if (!_fastMode)
                if (this._matchPriceCount >= (1 << 7)) {
                    this.fillDistancesPrices();
                }
                if (this._alignPriceCount >= Base.kAlignTableSize) {
                    this.fillAlignPrices();
                }
                inSize[0] = this.nowPos64;
                outSize[0] = this._rangeEncoder.getProcessedSizeAdd();

                if (this._matchFinder.getNumAvailableBytes() === 0) {
                    this.flush(this.nowPos64);
                    return;
                }

                if (this.nowPos64 - progressPosValuePrev >= (1 << 12)) {
                    this._finished = false;
                    finished[0] = false;
                    return;
                }
            }
        }
    };

    Encoder.prototype.releaseMFStream = function () {
        if (this._matchFinder && this._needReleaseMFStream) {
            this._matchFinder.releaseStream();
            this._needReleaseMFStream = false;
        }
    };

    Encoder.prototype.setOutStream = function (outStream) {
        this._rangeEncoder.setStream(outStream);
    };
    Encoder.prototype.releaseOutStream = function () {
        this._rangeEncoder.releaseStream();
    };

    Encoder.prototype.releaseStreams = function () {
        this.releaseMFStream();
        this.releaseOutStream();
    };

    Encoder.prototype.setStreams = function (inStream, outStream, inSize, outSize) {
        this._inStream = inStream;
        this._finished = false;
        this.create();
        this.setOutStream(outStream);
        this.init();

        // if (!_fastMode)
        if (true) {
            this.fillDistancesPrices();
            this.fillAlignPrices();
        }

        this._lenEncoder.setTableSize(this._numFastBytes + 1 - Base.kMatchMinLen);
        this._lenEncoder.updateTables(1 << this._posStateBits);
        this._repMatchLenEncoder.setTableSize(this._numFastBytes +
            1 - Base.kMatchMinLen);
        this._repMatchLenEncoder.updateTables(1 << this._posStateBits);

        this.nowPos64 = 0;
    };

    Encoder.prototype.code = function (inStream, outStream, inSize, outSize, progress) {
        this._needReleaseMFStream = false;
        try {
            this.setStreams(inStream, outStream, inSize, outSize);
            while (true) {

                this.codeOneBlock(this.processedInSize, this.processedOutSize,
                    this.finished);
                if (this.finished[0]) {
                    return;
                }
                if (progress) {
                    progress.setProgress(this.processedInSize[0], this.processedOutSize[0]);
                }
            }
        } finally {
            this.releaseStreams();
        }
    };

    Encoder.prototype.writeCoderProperties = function (outStream) {
        var properties = makeBuffer(kPropSize),
            i;
        properties[0] = ((this._posStateBits * 5 + this._numLiteralPosStateBits) * 9 +
            this._numLiteralContextBits);
        for (i = 0; i < 4; i++) {
            properties[1 + i] = (this._dictionarySize >>> (8 * i));
        }
        for (i = 0; i < kPropSize; i++) {
            outStream.writeByte(properties[i]);
        }
    };

    Encoder.prototype.fillDistancesPrices = function () {
        var tempPrices = [];
        tempPrices.length = Base.kNumFullDistances;
        var i, posSlot;
        for (i = Base.kStartPosModelIndex; i < Base.kNumFullDistances; i++) {
            posSlot = getPosSlot(i);
            var footerBits = ((posSlot >>> 1) - 1);
            var baseVal = ((2 | (posSlot & 1)) << footerBits);
            tempPrices[i] =
                RangeCoder.BitTreeEncoder.reverseGetPrice(this._posEncoders,
                    baseVal - posSlot - 1,
                    footerBits, i - baseVal);
        }

        var lenToPosState = 0;
        for (; lenToPosState < Base.kNumLenToPosStates; lenToPosState++) {
            var encoder = this._posSlotEncoder[lenToPosState];

            var st = (lenToPosState << Base.kNumPosSlotBits);
            for (posSlot = 0; posSlot < this._distTableSize; posSlot++) {
                this._posSlotPrices[st + posSlot] = encoder.getPrice(posSlot);
            }
            for (posSlot = Base.kEndPosModelIndex; posSlot < this._distTableSize; posSlot++) {
                this._posSlotPrices[st + posSlot] += ((((posSlot >>> 1) - 1) - Base.kNumAlignBits) << RangeCoder.Encoder.kNumBitPriceShiftBits);
            }

            var st2 = lenToPosState * Base.kNumFullDistances;
            for (i = 0; i < Base.kStartPosModelIndex; i++) {
                this._distancesPrices[st2 + i] = this._posSlotPrices[st + i];
            }
            for (; i < Base.kNumFullDistances; i++) {
                this._distancesPrices[st2 + i] =
                    this._posSlotPrices[st + getPosSlot(i)] + tempPrices[i];
            }
        }
        this._matchPriceCount = 0;
    };

    Encoder.prototype.fillAlignPrices = function () {
        var i;
        for (i = 0; i < Base.kAlignTableSize; i++) {
            this._alignPrices[i] = this._posAlignEncoder.reverseGetPrice(i);
        }
        this._alignPriceCount = 0;
    };

    Encoder.prototype.setAlgorithm = function (algorithm) {
        /*
    _fastMode = (algorithm == 0);
    _maxMode = (algorithm >= 2);
  */
        return true;
    };

    Encoder.prototype.setDictionarySize = function (dictionarySize) {
        var kDicLogSizeMaxCompress = 29;
        if (dictionarySize < (1 << Base.kDicLogSizeMin) ||
            dictionarySize > (1 << kDicLogSizeMaxCompress)) {
            return false;
        }
        this._dictionarySize = dictionarySize;
        var dicLogSize = 0;
        while (dictionarySize > (1 << dicLogSize)) {
            dicLogSize++;
        }
        this._distTableSize = dicLogSize * 2;
        return true;
    };

    Encoder.prototype.setNumFastBytes = function (numFastBytes) {
        if (numFastBytes < 5 || numFastBytes > Base.kMatchMaxLen) {
            return false;
        }
        this._numFastBytes = numFastBytes;
        return true;
    };

    Encoder.prototype.setMatchFinder = function (matchFinderIndex) {
        if (matchFinderIndex < 0 || matchFinderIndex > 2) {
            return false;
        }
        var matchFinderIndexPrev = this._matchFinderType;
        this._matchFinderType = matchFinderIndex;
        if (this._matchFinder && matchFinderIndexPrev != this._matchFinderType) {
            this._dictionarySizePrev = -1;
            this._matchFinder = null;
        }
        return true;
    };

    Encoder.prototype.setLcLpPb = function (lc, lp, pb) {
        if (lp < 0 || lp > Base.kNumLitPosStatesBitsEncodingMax ||
            lc < 0 || lc > Base.kNumLitContextBitsMax ||
            pb < 0 || pb > Base.kNumPosStatesBitsEncodingMax) {
            return false;
        }
        this._numLiteralPosStateBits = lp;
        this._numLiteralContextBits = lc;
        this._posStateBits = pb;
        this._posStateMask = ((1) << this._posStateBits) - 1;
        return true;
    };

    Encoder.prototype.setEndMarkerMode = function (endMarkerMode) {
        this._writeEndMark = endMarkerMode;
    };

    Encoder.EMatchFinderTypeBT2 = EMatchFinderTypeBT2;
    Encoder.EMatchFinderTypeBT4 = EMatchFinderTypeBT4;

    return {
        'Decoder': Decoder,
        'Encoder': Encoder
    };

})();

/* lib/Stream.js */

/* very simple input/output stream interface */
var Stream = function () {};

// input streams //////////////
/** Returns the next byte, or -1 for EOF. */
Stream.prototype.readByte = function () {
    throw new Error("abstract method readByte() not implemented");
};
/** Attempts to fill the buffer; returns number of bytes read, or
 *  -1 for EOF. */
Stream.prototype.read = function (buffer, bufOffset, length) {
    var bytesRead = 0;
    while (bytesRead < length) {
        var c = this.readByte();
        if (c < 0) { // EOF
            return (bytesRead === 0) ? -1 : bytesRead;
        }
        buffer[bufOffset++] = c;
        bytesRead++;
    }
    return bytesRead;
};
Stream.prototype.seek = function (new_pos) {
    throw new Error("abstract method seek() not implemented");
};

// output streams ///////////
Stream.prototype.writeByte = function (_byte) {
    throw new Error("abstract method readByte() not implemented");
};
Stream.prototype.write = function (buffer, bufOffset, length) {
    var i;
    for (i = 0; i < length; i++) {
        this.writeByte(buffer[bufOffset++]);
    }
    return length;
};
Stream.prototype.flush = function () {};


/* lib/Util.js */

/*
Copyright (c) 2011 Juan Mellado

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

/*
References:
- "LZMA SDK" by Igor Pavlov
  http://www.7-zip.org/sdk.html
*/
/* Original source found at: http://code.google.com/p/js-lzma/ */

var coerceInputStream = function (input) {
    if ('readByte' in input) {
        return input;
    }
    var inputStream = new Stream();
    inputStream.pos = 0;
    inputStream.size = input.length;
    inputStream.readByte = function () {
        return this.eof() ? -1 : input[this.pos++];
    };
    inputStream.read = function (buffer, bufOffset, length) {
        var bytesRead = 0;
        while (bytesRead < length && this.pos < input.length) {
            buffer[bufOffset++] = input[this.pos++];
            bytesRead++;
        }
        return bytesRead;
    };
    inputStream.seek = function (pos) {
        this.pos = pos;
    };
    inputStream.eof = function () {
        return this.pos >= input.length;
    };
    return inputStream;
};

var coerceOutputStream = function (output) {
    var outputStream = new Stream();
    var resizeOk = true;
    if (output) {
        if (typeof (output) === 'number') {
            outputStream.buffer = new Buffer(output);
            resizeOk = false;
        } else if ('writeByte' in output) {
            return output;
        } else {
            outputStream.buffer = output;
            resizeOk = false;
        }
    } else {
        outputStream.buffer = new Buffer(16384);
    }
    outputStream.pos = 0;
    outputStream.writeByte = function (_byte) {
        if (resizeOk && this.pos >= this.buffer.length) {
            var newBuffer = new Buffer(this.buffer.length * 2);
            this.buffer.copy(newBuffer);
            this.buffer = newBuffer;
        }
        this.buffer[this.pos++] = _byte;
    };
    outputStream.getBuffer = function () {
        // trim buffer
        if (this.pos !== this.buffer.length) {
            if (!resizeOk)
                throw new TypeError('outputsize does not match decoded input');
            var newBuffer = new Buffer(this.pos);
            this.buffer.copy(newBuffer, 0, 0, this.pos);
            this.buffer = newBuffer;
        }
        return this.buffer;
    };
    outputStream._coerced = true;
    return outputStream;
};

var Util = Object.create(null);

Util.decompress = function (properties, inStream, outStream, outSize) {
    var decoder = new LZMA.Decoder();

    if (!decoder.setDecoderProperties(properties)) {
        throw "Incorrect stream properties";
    }

    if (!decoder.code(inStream, outStream, outSize)) {
        throw "Error in data stream";
    }

    return true;
};

/* Also accepts a Uint8Array/Buffer/array as first argument, in which case
 * returns the decompressed file as a Uint8Array/Buffer/array. */
Util.decompressFile = function(inStream, outStream){
  var decoder = new LZMA.Decoder(), i, mult;

  inStream = coerceInputStream(inStream);

  if ( !decoder.setDecoderPropertiesFromStream(inStream) ){
    throw "Incorrect stream properties";
  }

  // largest integer in javascript is 2^53 (unless we use typed arrays)
  // but we don't explicitly check for overflow here.  caveat user.
  var outSizeLo = 0;
  for (i=0, mult=1; i<4; i++, mult*=256) {
    outSizeLo += (inStream.readByte() * mult);
  }
  var outSizeHi = 0;
  for (i=0, mult=1; i<4; i++, mult*=256) {
    outSizeHi += (inStream.readByte() * mult);
  }
  var outSize = outSizeLo + (outSizeHi * 0x100000000);
  if (outSizeLo === 0xFFFFFFFF && outSizeHi === 0xFFFFFFFF) {
    outSize = -1;
  } else if (outSizeHi >= 0x200000) {
    outSize = -1; // force streaming
  }

  if (outSize >= 0 && !outStream) { outStream = outSize; }
  outStream = coerceOutputStream(outStream);

  if ( !decoder.code(inStream, outStream, outSize) ){
    throw "Error in data stream";
  }

  return ('getBuffer' in outStream) ? outStream.getBuffer() : true;
};

/* The following is a mapping from gzip/bzip2 style -1 .. -9 compression modes
 * to the corresponding LZMA compression modes. Thanks, Larhzu, for coining
 * these. */
/* [csa] lifted from lzmp.cpp in the LZMA SDK. */
var option_mapping = [{
        a: 0,
        d: 0,
        fb: 0,
        mf: null,
        lc: 0,
        lp: 0,
        pb: 0
    }, // -0 (needed for indexing)
    {
        a: 0,
        d: 16,
        fb: 64,
        mf: "hc4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -1
    {
        a: 0,
        d: 20,
        fb: 64,
        mf: "hc4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -2
    {
        a: 1,
        d: 19,
        fb: 64,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -3
    {
        a: 2,
        d: 20,
        fb: 64,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -4
    {
        a: 2,
        d: 21,
        fb: 128,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -5
    {
        a: 2,
        d: 22,
        fb: 128,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -6
    {
        a: 2,
        d: 23,
        fb: 128,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -7
    {
        a: 2,
        d: 24,
        fb: 255,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    }, // -8
    {
        a: 2,
        d: 25,
        fb: 255,
        mf: "bt4",
        lc: 3,
        lp: 0,
        pb: 2
    } // -9
];

/** Create and configure an Encoder, based on the given properties (which
 *  make be a simple number, for a compression level between 1 and 9. */
var makeEncoder = function (props) {
    var encoder = new LZMA.Encoder();
    var params = { // defaults!
        a: 1,
        /* algorithm */
        d: 23,
        /* dictionary */
        fb: 128,
        /* fast bytes */
        lc: 3,
        /* literal context */
        lp: 0,
        /* literal position */
        pb: 2,
        /* position bits */
        mf: "bt4",
        /* match finder (bt2/bt4) */
        eos: false /* write end of stream */
    };
    // override default params with props
    if (props) {
        if (typeof (props) === 'number') { // -1 through -9 options
            props = option_mapping[props];
        }
        var p;
        for (p in props) {
            if (Object.prototype.hasOwnProperty.call(props, p)) {
                params[p] = props[p];
            }
        }
    }
    encoder.setAlgorithm(params.a);
    encoder.setDictionarySize(1 << (+params.d));
    encoder.setNumFastBytes(+params.fb);
    encoder.setMatchFinder((params.mf === 'bt4') ?
        LZMA.Encoder.EMatchFinderTypeBT4 :
        LZMA.Encoder.EMatchFinderTypeBT2);
    encoder.setLcLpPb(+params.lc, +params.lp, +params.pb);
    encoder.setEndMarkerMode(!!params.eos);
    return encoder;
};

Util.compress = function (inStream, outStream, props, progress) {
    var encoder = makeEncoder(props);

    encoder.writeCoderProperties(outStream);

    encoder.code(inStream, outStream, -1, -1, {
        setProgress: function (inSize, outSize) {
            if (progress) {
                progress(inSize, outSize);
            }
        }
    });

    return true;
};

/* Also accepts a Uint8Array/Buffer/array as first argument, in which case
 * returns the compressed file as a Uint8Array/Buffer/array. */
Util.compressFile = function(inStream, outStream, props, progress) {
  var encoder = makeEncoder(props);
  var i;

  inStream = coerceInputStream(inStream);
  // if we know the size, write it; otherwise we need to use the 'eos' property
  var fileSize;
  if ('size' in inStream && inStream.size >= 0) {
    fileSize = inStream.size;
  } else {
    fileSize = -1;
    encoder.setEndMarkerMode(true);
  }

  outStream = coerceOutputStream(outStream);

  encoder.writeCoderProperties(outStream);

  var out64 = function(s) {
    // supports up to 53-bit integers
    var i;
    for (i=0;i<8;i++) {
      outStream.writeByte(s & 0xFF);
      s = Math.floor(s/256);
    }
  };
  out64(fileSize);

  encoder.code(inStream, outStream, fileSize, -1, {
    setProgress: function(inSize, outSize) {
      if (progress) { progress(inSize, outSize); }
    }
  });

  return ('getBuffer' in outStream) ? outStream.getBuffer() : true;
};

/* github.com/arextar/browser-buffer */

// Based off of buffer.js in the Node project(copyright Joyent, Inc. and other Node contributors.)
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

(function () {
    "use strict";

    function isArrayIsh(subject) {
        return Buffer.isBuffer(subject) || subject && typeof subject === 'object' && typeof subject.length === 'number';
    }

    function coerce(length) {
        length = ~~Math.ceil(+length);
        return length < 0 ? 0 : length;
    }

    function ok(cond, msg) {
        if (!cond) throw new Error(msg);
    }

    var ArrayBuffer = self.ArrayBuffer ||
        function (len) {
            this.length = len;
            while (len--) this[len] = 0;
        }, Uint8Array = self.Uint8Array ||
        function (parent, offset, length) {
            this.buffer = parent;
            this.offset = offset;
            this.length = length;
        }, __set = 'Uint8Array' in self && Uint8Array.prototype.set;

    self.Uint8Array || (Uint8Array.prototype = {
        get: function (ind) {
            return this.buffer[ind + this.offset];
        },
        set: function (ind, value) {
            this.buffer[ind + this.offset] = value;
        }
    })

    var makeBuffer = function (parent, offset, length) {
            var buf = new Uint8Array(parent, offset, length);
            buf.parent = parent;
            buf.offset = offset;
            return buf;
        },

        Buffer = function (subject, encoding, offset) {
            var type, length, parent, ret;

            // Are we slicing?
            if (typeof offset === 'number') {
                length = coerce(encoding);
                parent = subject;
            } else {
                // Find the length
                switch (type = typeof subject) {
                    case 'number':
                        length = coerce(subject);
                        break;

                    case 'string':
                        length = Buffer.byteLength(subject, encoding);
                        break;

                    case 'object':
                        // Assume object is an array
                        length = coerce(subject.length);
                        break;

                    default:
                        throw new Error('First argument needs to be a number, ' + 'array or string.');
                }

                if (length > Buffer.poolSize) {
                    // Big buffer, just alloc one.
                    parent = new ArrayBuffer(length);
                    offset = 0;
                } else {
                    // Small buffer.
                    if (!pool || pool.byteLength - pool.used < length) allocPool();
                    parent = pool;
                    offset = pool.used;
                    pool.used += length;
                }

                // Treat array-ish objects as a byte array.
                if (isArrayIsh(subject)) {
                    ret = makeBuffer(parent, offset, length);
                    var i = length;
                    while (i--) {
                        ret[i] = subject[i];
                    }
                } else if (type == 'string') {
                    ret = makeBuffer(parent, offset, length);
                    length = ret.write(subject, 0, encoding);
                }
            }

            return ret || makeBuffer(parent, offset, length);
        },

        proto = Buffer.prototype = Uint8Array.prototype;

    proto.toString = function (encoding, start, end) {
        encoding = String(encoding || 'utf8').toLowerCase();
        start = +start || 0;
        if (typeof end == 'undefined') end = this.length;

        // Fastpath empty strings
        if (+end == start) {
            return '';
        }

        switch (encoding) {
            case 'hex':
                return this.hexSlice(start, end);

            case 'utf8':
            case 'utf-8':
                return this.utf8Slice(start, end);

            case 'ascii':
                return this.asciiSlice(start, end);

            case 'base64':
                return this.base64Slice(start, end);

            /*case 'binary':
             return this.binarySlice(start, end);

             case 'ucs2':
             case 'ucs-2':
             return this.ucs2Slice(start, end);*/

            default:
                throw new Error('Unknown encoding');
        }
    }

    proto.write = function (string, offset, length, encoding) {
        // Support both (string, offset, length, encoding)
        // and the legacy (string, encoding, offset, length)
        if (isFinite(offset)) {
            if (!isFinite(length)) {
                encoding = length;
                length = undefined;
            }
        } else { // legacy
            var swap = encoding;
            encoding = offset;
            offset = length;
            length = swap;
        }

        offset = +offset || 0;
        var remaining = this.length - offset;
        if (!length) {
            length = remaining;
        } else {
            length = +length;
            if (length > remaining) {
                length = remaining;
            }
        }
        encoding = String(encoding || 'utf8').toLowerCase();

        switch (encoding) {
            /*case 'hex':
             return this.hexWrite(string, offset, length);*/

            case 'utf8':
            case 'utf-8':
                return this.utf8Write(string, offset, length);

            case 'ascii':
                return this.asciiWrite(string, offset, length);

            case 'base64':
                return this.base64Write(string, offset, length);

            /*case 'binary':
             return this.binaryWrite(string, offset, length);

             case 'ucs2':
             case 'ucs-2':
             return this.ucs2Write(string, offset, length);*/

            default:
                throw new Error('Unknown encoding');
        }
    };


    var fCC = String.fromCharCode;

    proto.utf8Write = function (string, start, end) {
        for (var i = 0, l = start, le = string.length, d = end - start; i < d && i < le; i++) {
            var c = string.charCodeAt(i);

            if (c < 128) {
                this[l++] = c;
            } else if ((c > 127) && (c < 2048)) {
                this[l++] = (c >> 6) | 192;
                this[l++] = (c & 63) | 128;
            } else {
                this[l++] = (c >> 12) | 224;
                this[l++] = ((c >> 6) & 63) | 128;
                this[l++] = (c & 63) | 128;
            }
        }
        this._charsWritten = l;
        return le;
    }

    proto.utf8Slice = function (start, end) {
        for (var string = "", c, i = start, p = 0, c2, c3; p < end && (c = this[i]); i++) {
            p++;
            if (c < 128) {
                string += fCC(c);
            } else if ((c > 191) && (c < 224)) {
                c2 = this[i + 1];
                string += fCC(((c & 31) << 6) | (c2 & 63));
                i++;
            } else {
                c2 = this[i + 1];
                c3 = this[i + 2];
                string += fCC(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
                i += 2;
            }
        }
        return string;
    }

    proto.asciiWrite = function (string, start, end) {
        for (var i = 0, le = string.length; i < end && i < le; i++) {
            this[i + start] = string.charCodeAt(i);
        }
        this._charsWritten = i;
        return le;
    }

    proto.asciiSlice = function (start, end) {
        for (var string = "", i = start; i < end; i++) {
            string += fCC(this[i]);
        }
        return string;
    }

    function toHex(n) {
        if (n < 16) return '0' + n.toString(16);
        return n.toString(16);
    }

    proto.hexSlice = function (start, end) {
        var len = this.length;

        if (!start || start < 0) start = 0;
        if (!end || end < 0 || end > len) end = len;

        var out = '';
        for (var i = start; i < end; i++) {
            out += toHex(this[i]);
        }
        return out;
    };

    proto.copy = function (target, tStart, sStart, sEnd) {
        for (var i = 0, d = sEnd - sStart; i < d; i++) {
            target[i + tStart] = this[i + sStart];
        }
    }


    proto.base64Slice = function (start, end) {
        var len = this.length;

        if (!start || start < 0) start = 0;
        if (!end || end < 0 || end > len) end = len;

        var out = '';
        for (var i = start; i < end; i++) {
            out += self.btoa(this[i]);
        }
        return out;
    };

    proto.base64Write = function (string, start, end) {
        for (var i = 0, le = string.length; i < end && i < le; i++) {
            this[i + start] = self.atob( string.charCodeAt(i) );
        }
        this._charsWritten = i;
        return le;
    }



    proto.slice = function (start, end) {
        if (end === undefined) end = this.length;

        if (end > this.length) {
            throw new Error('oob');
        }
        if (start > end) {
            throw new Error('oob');
        }

        return makeBuffer(this.buffer, +start, end - start);
    };

    proto.toBlob = function () {
        var b = new (self.BlobBuilder || self.WebKitBlobBuilder || self.MozBlobBuilder);
        this.offset ? b.append(this.toString('utf8')) : b.append(this.buffer);
        return b.getBlob();
    }

    proto.readUInt8 = function (offset, noAssert) {
        var buffer = this;

        if (!noAssert) {
            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset < buffer.length,
                'Trying to read beyond buffer length');
        }

        return buffer[offset];
    };

    function readUInt16(buffer, offset, isBigEndian, noAssert) {
        var val = 0;


        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 1 < buffer.length,
                'Trying to read beyond buffer length');
        }

        if (isBigEndian) {
            val = buffer[offset] << 8;
            val |= buffer[offset + 1];
        } else {
            val = buffer[offset];
            val |= buffer[offset + 1] << 8;
        }

        return val;
    }

    proto.readUInt16LE = function (offset, noAssert) {
        return readUInt16(this, offset, false, noAssert);
    };

    proto.readUInt16BE = function (offset, noAssert) {
        return readUInt16(this, offset, true, noAssert);
    };

    function readUInt32(buffer, offset, isBigEndian, noAssert) {
        var val = 0;

        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 3 < buffer.length,
                'Trying to read beyond buffer length');
        }

        if (isBigEndian) {
            val = buffer[offset + 1] << 16;
            val |= buffer[offset + 2] << 8;
            val |= buffer[offset + 3];
            val = val + (buffer[offset] << 24 >>> 0);
        } else {
            val = buffer[offset + 2] << 16;
            val |= buffer[offset + 1] << 8;
            val |= buffer[offset];
            val = val + (buffer[offset + 3] << 24 >>> 0);
        }

        return val;
    }

    proto.readUInt32LE = function (offset, noAssert) {
        return readUInt32(this, offset, false, noAssert);
    };

    proto.readUInt32BE = function (offset, noAssert) {
        return readUInt32(this, offset, true, noAssert);
    };

    proto.readInt8 = function (offset, noAssert) {
        var buffer = this;
        var neg;

        if (!noAssert) {
            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset < buffer.length,
                'Trying to read beyond buffer length');
        }

        neg = buffer[offset] & 0x80;
        if (!neg) {
            return (buffer[offset]);
        }

        return ((0xff - buffer[offset] + 1) * -1);
    };

    function readInt16(buffer, offset, isBigEndian, noAssert) {
        var neg, val;

        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 1 < buffer.length,
                'Trying to read beyond buffer length');
        }

        val = readUInt16(buffer, offset, isBigEndian, noAssert);
        neg = val & 0x8000;
        if (!neg) {
            return val;
        }

        return (0xffff - val + 1) * -1;
    }

    proto.readInt16LE = function (offset, noAssert) {
        return readInt16(this, offset, false, noAssert);
    };

    proto.readInt16BE = function (offset, noAssert) {
        return readInt16(this, offset, true, noAssert);
    };

    function readInt32(buffer, offset, isBigEndian, noAssert) {
        var neg, val;

        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 3 < buffer.length,
                'Trying to read beyond buffer length');
        }

        val = readUInt32(buffer, offset, isBigEndian, noAssert);
        neg = val & 0x80000000;
        if (!neg) {
            return (val);
        }

        return (0xffffffff - val + 1) * -1;
    }

    proto.readInt32LE = function (offset, noAssert) {
        return readInt32(this, offset, false, noAssert);
    };

    proto.readInt32BE = function (offset, noAssert) {
        return readInt32(this, offset, true, noAssert);
    };

    function readIEEE754(buffer, offset, isBE, mLen, nBytes) {
        var e, m,
            eLen = nBytes * 8 - mLen - 1,
            eMax = (1 << eLen) - 1,
            eBias = eMax >> 1,
            nBits = -7,
            i = isBE ? 0 : (nBytes - 1),
            d = isBE ? 1 : -1,
            s = buffer[offset + i];

        i += d;

        e = s & ((1 << (-nBits)) - 1);
        s >>= (-nBits);
        nBits += eLen;
        for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);

        m = e & ((1 << (-nBits)) - 1);
        e >>= (-nBits);
        nBits += mLen;
        for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);

        if (e === 0) {
            e = 1 - eBias;
        } else if (e === eMax) {
            return m ? NaN : ((s ? -1 : 1) * Infinity);
        } else {
            m = m + Math.pow(2, mLen);
            e = e - eBias;
        }
        return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
    };

    function readFloat(buffer, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset + 3 < buffer.length,
                'Trying to read beyond buffer length');
        }

        return readIEEE754(buffer, offset, isBigEndian,
            23, 4);
    }

    proto.readFloatLE = function (offset, noAssert) {
        return readFloat(this, offset, false, noAssert);
    };

    proto.readFloatBE = function (offset, noAssert) {
        return readFloat(this, offset, true, noAssert);
    };

    function readDouble(buffer, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset + 7 < buffer.length,
                'Trying to read beyond buffer length');
        }

        return readIEEE754(buffer, offset, isBigEndian,
            52, 8);
    }

    proto.readDoubleLE = function (offset, noAssert) {
        return readDouble(this, offset, false, noAssert);
    };

    proto.readDoubleBE = function (offset, noAssert) {
        return readDouble(this, offset, true, noAssert);
    };


    function verifuint(value, max) {
        ok(typeof (value) == 'number',
            'cannot write a non-number as a number');

        ok(value >= 0,
            'specified a negative value for writing an unsigned value');

        ok(value <= max, 'value is larger than maximum value for type');

        ok(Math.floor(value) === value, 'value has a fractional component');
    }

    proto.writeUInt8 = function (value, offset, noAssert) {
        var buffer = this;

        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset < buffer.length,
                'trying to write beyond buffer length');

            verifuint(value, 0xff);
        }

        buffer[offset] = value;
    };

    function writeUInt16(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 1 < buffer.length,
                'trying to write beyond buffer length');

            verifuint(value, 0xffff);
        }

        if (isBigEndian) {
            buffer[offset] = (value & 0xff00) >>> 8;
            buffer[offset + 1] = value & 0x00ff;
        } else {
            buffer[offset + 1] = (value & 0xff00) >>> 8;
            buffer[offset] = value & 0x00ff;
        }
    }

    proto.writeUInt16LE = function (value, offset, noAssert) {
        writeUInt16(this, value, offset, false, noAssert);
    };

    proto.writeUInt16BE = function (value, offset, noAssert) {
        writeUInt16(this, value, offset, true, noAssert);
    };

    function writeUInt32(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 3 < buffer.length,
                'trying to write beyond buffer length');

            verifuint(value, 0xffffffff);
        }

        if (isBigEndian) {
            buffer[offset] = (value >>> 24) & 0xff;
            buffer[offset + 1] = (value >>> 16) & 0xff;
            buffer[offset + 2] = (value >>> 8) & 0xff;
            buffer[offset + 3] = value & 0xff;
        } else {
            buffer[offset + 3] = (value >>> 24) & 0xff;
            buffer[offset + 2] = (value >>> 16) & 0xff;
            buffer[offset + 1] = (value >>> 8) & 0xff;
            buffer[offset] = value & 0xff;
        }
    }

    proto.writeUInt32LE = function (value, offset, noAssert) {
        writeUInt32(this, value, offset, false, noAssert);
    };

    proto.writeUInt32BE = function (value, offset, noAssert) {
        writeUInt32(this, value, offset, true, noAssert);
    };


    /*
     * We now move onto our friends in the signed number category. Unlike unsigned
     * numbers, we're going to have to worry a bit more about how we put values into
     * arrays. Since we are only worrying about signed 32-bit values, we're in
     * slightly better shape. Unfortunately, we really can't do our favorite binary
     * & in this system. It really seems to do the wrong thing. For example:
     *
     * > -32 & 0xff
     * 224
     *
     * What's happening above is really: 0xe0 & 0xff = 0xe0. However, the results of
     * this aren't treated as a signed number. Ultimately a bad thing.
     *
     * What we're going to want to do is basically create the unsigned equivalent of
     * our representation and pass that off to the wuint* functions. To do that
     * we're going to do the following:
     *
     *  - if the value is positive
     *      we can pass it directly off to the equivalent wuint
     *  - if the value is negative
     *      we do the following computation:
     *         mb + val + 1, where
     *         mb   is the maximum unsigned value in that byte size
     *         val  is the Javascript negative integer
     *
     *
     * As a concrete value, take -128. In signed 16 bits this would be 0xff80. If
     * you do out the computations:
     *
     * 0xffff - 128 + 1
     * 0xffff - 127
     * 0xff80
     *
     * You can then encode this value as the signed version. This is really rather
     * hacky, but it should work and get the job done which is our goal here.
     */

    /*
     * A series of checks to make sure we actually have a signed 32-bit number
     */
    function verifsint(value, max, min) {
        ok(typeof (value) == 'number',
            'cannot write a non-number as a number');

        ok(value <= max, 'value larger than maximum allowed value');

        ok(value >= min, 'value smaller than minimum allowed value');

        ok(Math.floor(value) === value, 'value has a fractional component');
    }

    function verifIEEE754(value, max, min) {
        ok(typeof (value) == 'number',
            'cannot write a non-number as a number');

        ok(value <= max, 'value larger than maximum allowed value');

        ok(value >= min, 'value smaller than minimum allowed value');
    }

    proto.writeInt8 = function (value, offset, noAssert) {
        var buffer = this;

        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset < buffer.length,
                'Trying to write beyond buffer length');

            verifsint(value, 0x7f, -0x80);
        }

        if (value >= 0) {
            buffer.writeUInt8(value, offset, noAssert);
        } else {
            buffer.writeUInt8(0xff + value + 1, offset, noAssert);
        }
    };

    function writeInt16(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 1 < buffer.length,
                'Trying to write beyond buffer length');

            verifsint(value, 0x7fff, -0x8000);
        }

        if (value >= 0) {
            writeUInt16(buffer, value, offset, isBigEndian, noAssert);
        } else {
            writeUInt16(buffer, 0xffff + value + 1, offset, isBigEndian, noAssert);
        }
    }

    proto.writeInt16LE = function (value, offset, noAssert) {
        writeInt16(this, value, offset, false, noAssert);
    };

    proto.writeInt16BE = function (value, offset, noAssert) {
        writeInt16(this, value, offset, true, noAssert);
    };

    function writeInt32(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 3 < buffer.length,
                'Trying to write beyond buffer length');

            verifsint(value, 0x7fffffff, -0x80000000);
        }

        if (value >= 0) {
            writeUInt32(buffer, value, offset, isBigEndian, noAssert);
        } else {
            writeUInt32(buffer, 0xffffffff + value + 1, offset, isBigEndian, noAssert);
        }
    }

    proto.writeInt32LE = function (value, offset, noAssert) {
        writeInt32(this, value, offset, false, noAssert);
    };

    proto.writeInt32BE = function (value, offset, noAssert) {
        writeInt32(this, value, offset, true, noAssert);
    };

    function writeIEEE754(buffer, value, offset, isBE, mLen, nBytes) {
        var e, m, c,
            eLen = nBytes * 8 - mLen - 1,
            eMax = (1 << eLen) - 1,
            eBias = eMax >> 1,
            rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
            i = isBE ? (nBytes - 1) : 0,
            d = isBE ? -1 : 1,
            s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

        value = Math.abs(value);

        if (isNaN(value) || value === Infinity) {
            m = isNaN(value) ? 1 : 0;
            e = eMax;
        } else {
            e = Math.floor(Math.log(value) / Math.LN2);
            if (value * (c = Math.pow(2, -e)) < 1) {
                e--;
                c *= 2;
            }
            if (e + eBias >= 1) {
                value += rt / c;
            } else {
                value += rt * Math.pow(2, 1 - eBias);
            }
            if (value * c >= 2) {
                e++;
                c /= 2;
            }

            if (e + eBias >= eMax) {
                m = 0;
                e = eMax;
            } else if (e + eBias >= 1) {
                m = (value * c - 1) * Math.pow(2, mLen);
                e = e + eBias;
            } else {
                m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
                e = 0;
            }
        }

        for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8);

        e = (e << mLen) | m;
        eLen += mLen;
        for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8);

        buffer[offset + i - d] |= s * 128;
    };

    function writeFloat(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 3 < buffer.length,
                'Trying to write beyond buffer length');

            verifIEEE754(value, 3.4028234663852886e+38, -3.4028234663852886e+38);
        }

        writeIEEE754(buffer, value, offset, isBigEndian,
            23, 4);
    }

    proto.writeFloatLE = function (value, offset, noAssert) {
        writeFloat(this, value, offset, false, noAssert);
    };

    proto.writeFloatBE = function (value, offset, noAssert) {
        writeFloat(this, value, offset, true, noAssert);
    };

    function writeDouble(buffer, value, offset, isBigEndian, noAssert) {
        if (!noAssert) {
            ok(value !== undefined && value !== null,
                'missing value');

            ok(typeof (isBigEndian) === 'boolean',
                'missing or invalid endian');

            ok(offset !== undefined && offset !== null,
                'missing offset');

            ok(offset + 7 < buffer.length,
                'Trying to write beyond buffer length');

            verifIEEE754(value, 1.7976931348623157E+308, -1.7976931348623157E+308);
        }

        writeIEEE754(buffer, value, offset, isBigEndian,
            52, 8);
    }

    proto.writeDoubleLE = function (value, offset, noAssert) {
        writeDouble(this, value, offset, false, noAssert);
    };

    proto.writeDoubleBE = function (value, offset, noAssert) {
        writeDouble(this, value, offset, true, noAssert);
    };


    var pool;

    Buffer.poolSize = 8 * 1024;

    function allocPool() {
        pool = new ArrayBuffer(Buffer.poolSize);
        pool.used = 0;
    }

    Buffer.isBuffer = function isBuffer(b) {
        return b instanceof Buffer || b instanceof ArrayBuffer;
    };

    Buffer.byteLength = function (string, encoding) {
        switch (encoding) {
            case "ascii":
                return string.length;
        }
        for (var i = 0, l = 0, le = string.length, c; i < le; i++) {
            c = string.charCodeAt(i);
            if (c < 128) {
                l++;
            } else if ((c > 127) && (c < 2048)) {
                l += 2;
            } else {
                l += 3;
            }
        }
        return l;
    }

    self.Buffer = Buffer;
})();
