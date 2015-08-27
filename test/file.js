var assert = require("assert");
var lzmajs = require('../');
var fs = require('fs');

describe('lzma file decode', function(){
  ['sample0', 'sample1', 'sample2', 'sample3', 'sample4'].forEach(function(f) {
      it('should correctly decode '+f, function() {
          var compressedData = fs.readFileSync('test/'+f+'.lzma');
          var referenceData = fs.readFileSync('test/'+f+'.ref');
          var data = lzmajs.decompressFile(compressedData);
          // convert to buffer
          data = new Buffer(data);
          assert.equal(data.toString('hex'), referenceData.toString('hex'));
      });
  });
});

describe('lzma file encode->decode', function(){
  ['sample0', 'sample1', 'sample2', 'sample3', 'sample4'].forEach(function(f) {
      [1, 6, 9].forEach(function(compressionLevel) {
          it('encoded '+f+' should correctly decode with compressionLevel = '+compressionLevel, function() {
              var referenceData = fs.readFileSync('test/'+f+'.ref');
              var data = lzmajs.compressFile(referenceData, null, compressionLevel);
              // convert to buffer
              data = new Buffer(data);
              // round trip
              var data2 = lzmajs.decompressFile(data);
              // convert to buffer
              data2 = new Buffer(data2);
              assert.equal(referenceData.toString('hex'), data2.toString('hex'));
          });
      });
  });
});
