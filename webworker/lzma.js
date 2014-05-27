/*
 LZMA-PUREJS WebWorker Wrapper 0.1 | github.com/cscott/lzma-purejs | (c) 2011-2014 Marco Minetti | MIT */
this.LZMA = function (PathLZMA) {
	LZMAWorker = new Worker(PathLZMA);
	
	LZMAWorker.CallCounter = 0;	
	LZMAWorker.Requests = [];
	
	LZMAWorker.onmessage = function (event) {
		var Packet = event.data;
       
        if (LZMAWorker.Requests[Packet.PacketID] != null && typeof (LZMAWorker.Requests[Packet.PacketID].OnCompleteCallback) == "function") {
            LZMAWorker.Requests[Packet.PacketID].OnCompleteCallback(Packet.Result);
        }
        delete LZMAWorker.Requests[Packet.PacketID];
    };
    
    LZMAWorker.onerror = function(event) {
        throw new Error(event.message + " (" + event.filename + ":" + event.lineno + ")");
    };
        
    this.Compress = function(Data, Level, OnCompleteCallback) {   	
        LZMAWorker.CallCounter++;
        LZMAWorker.Requests[LZMAWorker.CallCounter] = {'OnCompleteCallback': OnCompleteCallback};

        if (Data.constructor == String) {
        	Data = new Uint8Array(stringToUtf8ByteArray(Data));
        }

        LZMAWorker.postMessage({
        	'Type':'compress',
        	'PacketID': LZMAWorker.CallCounter,
        	'Data': Data,
        	'Level': ((Level != null && typeof(Level)==='number' && Level > 0 && Level < 10) ? Level : 3)
        });
    };
    
    this.Decompress = function(Data, OnCompleteCallback) {
        LZMAWorker.CallCounter++;
        LZMAWorker.Requests[LZMAWorker.CallCounter] = {'OnCompleteCallback': OnCompleteCallback};

        if (Data.constructor == String) {
        	Data = new Uint8Array(stringToUtf8ByteArray(Data));
        }

        LZMAWorker.postMessage({
        	'Type':'decompress',
        	'PacketID': LZMAWorker.CallCounter,
        	'Data': Data
        });
    };
}
