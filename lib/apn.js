var net = require('net');
var crypto = require('crypto');
var fs = require('fs');
var Buffer = require('buffer').Buffer;

var Errors = {
	  'noErrorsEncountered': 0
	, 'processingError': 1
	, 'missingDeviceToken': 2
	, 'missingTopic': 3
	, 'missingPayload': 4
	, 'invalidTokenSize': 5
	, 'invalidTopicSize': 6
	, 'invalidPayloadSize': 7
	, 'invalidToken': 8
	, 'none': 255
}

var Connection = function (optionArgs) {
	this.socket = new net.Stream();
	this.credentials = crypto.createCredentials();
	this.currentId = 0;
	this.cachedNotes = [];

	var self = this;
	var hasKey = hasCert = false;
	
	var options =	{ cert: 'cert.pem' /* Certificate file */
					, key:	'key.pem'  /* Key file */
					, gateway: 'gateway.push.apple.com' /* gateway address */
					, port: 2195 /* gateway port */
					, enhanced: true /* enable enhanced format */
					, errorCallback: undefined /* Callback when error occurs */
					, cacheLength: 5 /* Number of notifications to cache for error purposes */
					};
	
	if (optionArgs) {
		var keys = Object.keys(options);
		for (var i = 0; i < keys.length; i++) {
			var k = keys[i];
			if (optionArgs[k] !== undefined) options[k] = optionArgs[k];
		}
	}
		
	var startSocket = function () {
		self.socket.connect(options['port'], options['gateway']);
	}
	
	self.socket.on('connect', function() { self.socket.setSecure(self.credentials); });
	self.socket.on('data', function(data) { handleTransmissionError(data); });
	self.socket.on('end', function () { self.socket.end(); });
	
	var connect = invoke_after(startSocket);
	
	fs.readFile(options['cert'], connect(function(err, data) {
		if(err) {
			throw err;
		}
		self.credentials.context.setCert(data.toString());
		hasCert = true;
	}));

	fs.readFile(options['key'], connect(function(err, data) {
		if(err) {
			throw err;
		}
		self.credentials.context.setKey(data.toString());
		hasKey = true;
	}));

	this.sendNotification = function (note) {
		var token = note.device.token;
		var message = JSON.stringify(note);
		var messageLength = Buffer.byteLength(message);
		var pos = 0;
		
		if(token === undefined) {
			return Errors['missingDeviceToken'];
		}
		if(messageLength > 256) {
			return Errors['invalidPayloadSize'];
		}
		
		note._uid = this.currentId++;
		
		if(options.enhanced) {
			var data = new Buffer(1 + 4 + 4 + 2 + token.length + 2 + messageLength);
			// Command
			data[pos] = 1;
			pos++;
			
			// Identifier
			pos += int2buf(note._uid, data, pos, 4);
			
			// Expiry
			pos += int2buf(note.expiry, data, pos, 4);
			
			self.cachedNotes.push(note);
			tidyCachedNotes();
		}
		else {
			var data = new Buffer(1 + 2 + token.length + 2 + messageLength);
			data[pos] = 0;
			pos++;
		}
		
		pos += int2buf(token.length, data, pos, 2);
		pos += token.copy(data, pos, 0);
		pos += int2buf(messageLength, data, pos, 2);
		pos += data.write(message, pos);
		
		// If error occurs then slice array and resend all stored notes.
		
		if(self.socket.readyState != 'open') {
			if(self.socket.readyState == 'closed' && hasKey && hasCert) {
				startSocket();
			}
			self.socket.on('connect', 
				function() { 
					self.socket.write(data); 
					self.socket.removeListener('connect', arguments.callee); 
				});
		}
		else {
			self.socket.write(data);
		}
	}
	
	var tidyCachedNotes = function() {
		// Maybe a timestamp should be stored for each note and kept for a duration?
		if(self.cachedNotes.length > options.cacheLength) {
			self.cachedNotes.shift();
		}
	}
		
	var handleTransmissionError = function(data) {
		// Need to check message that errors
		//	return failed notification to owner
		//	resend all following notifications
		if(data[0] == 8) {
			var currentCache = self.cachedNotes;
			self.cachedNotes = [];
			self.socket.end();
			// This is an error condition
			var errorCode = data[1];
			var identifier = bytes2int(data.slice(2,6), 4);
			var note = undefined;
			while(currentCache.length) {
				note = currentCache.shift();
				if(note['_uid'] == identifier) {
					break;
				}
			}
			// Notify callback of failed notification
			if(typeof errorCallback == 'function') {
				errorCallback(errorCode, note);
			}
			while(currentCache.length) {
				note = currentCache.shift();
				self.sendNotification(note);
			}
		}
	}
}

var Notification = function () {
	this.payload = {};
	this.expiry = 0;
	this.identifier = 0;
	this.device;
	
	this.alert = undefined;
	this.badge = undefined;
	this.sound = undefined;
}

Notification.prototype.toJSON = function() {
	if(this.payload.aps === undefined) {
		this.payload.aps = {};
	}
	if(typeof this.badge == 'number') {
		this.payload.aps.badge = this.badge;
	}
	if(typeof this.sound == 'string') {
		this.payload.aps.sound = this.sound;
	}
	if(typeof this.alert == 'string' || typeof this.alert == 'object') {
		this.payload.aps.alert = this.alert;
	}
	return this.payload;
}

var Device = function (/* deviceToken, ascii=false */) {
	var self = this;
	self.token = undefined;
	
	function parseToken(token) {
		token = token.replace(/\s/g, "");
		length = Number(token.length / 2);
		hexToken = new Buffer(length);
		for(var i=0; i < token.length; i+=2) {
			word = token[i];
			if((i + 1) >= token.length || typeof(token[i+1]) === undefined) {
				word += '0';
			}
			else {
				word += token[i+1];
			}
			hexToken[i/2] = parseInt(word, 16);
		}
		return hexToken;
	}
	
	Device.prototype.setToken = function (newToken, ascii) {
		if(ascii) {
			newToken = parseToken(newToken);
		}
		self.token = newToken;
		return self;
	}
	
	Device.prototype.hexToken = function () {
		var out = [],
			len = this.token.length;
		for (var i = 0; i < len; i++) {
			n = this.token[i];
			if (n < 16) out[i] = "0" + n.toString(16);
			else out[i] = n.toString(16);
		}
		return out.join("");
	}
		
	if(arguments.length > 0) {
		self.setToken.apply(self, arguments);
	}
}

var Feedback = function (optionArgs) {
	this.socket = new net.Stream();
	this.credentials = crypto.createCredentials();

	var self = this;
	var hasKey = hasCert = false;
	
	var responsePacketLength = 38;	
	var readBuffer = new Buffer(responsePacketLength);
	var readLength = 0;
	
	var options =	{ cert: 'cert.pem' /* Certificate file */
					, key:	'key.pem'  /* Key file */
					, address: 'feedback.push.apple.com' /* feedback address */
					, port: 2196 /* feedback port */
					, feedback: false /* enable feedback service, set to callback */
					, interval: 3600 /* interval in seconds to connect to feedback service */
					};
	
	if (optionArgs) {
		var keys = Object.keys(options);
		for (var i = 0; i < keys.length; i++) {
			var k = keys[i];
			if (optionArgs[k] !== undefined) options[k] = optionArgs[k];
		}
	}
	
	if(typeof options['feedback'] != 'function') {
		return Error(-1, 'A callback function must be specified');
	}
		
	var startSocket = function () {
		self.socket.connect(options['port'], options['address']);
	}
	
	self.socket.on('connect', function() { self.socket.setSecure(self.credentials); });
	self.socket.on('data', function(data) { processData(data); });
	self.socket.on('end', function () { self.socket.end(); });
	
	var connect = invoke_after(startSocket);
	
	fs.readFile(options['cert'], connect(function(err, data) {
		if(err) {
			throw err;
		}
		self.credentials.context.setCert(data.toString());
		hasCert = true;
	}));

	fs.readFile(options['key'], connect(function(err, data) {
		if(err) {
			throw err;
		}
		self.credentials.context.setKey(data.toString());
		hasKey = true;
	}));
	
	this.request = function () {
		if(self.socket.readyState == 'closed') {
			if(!hasKey || !hasCert) {
				// Connection will be made once both key and cert are available
				return;
			}
			startSocket();
		}
	}
	
	this.cancel = function () {
		if(this.interval !== undefined) {
			clearInterval(this.interval);
		}
	}
	
	if(options['interval'] > 0) {
		this.interval = setInterval(this.request, options['interval'] * 1000);
	}
	
	var processData = function(data) {
		var pos = 0;
		// If there is some buffered data read read the remainder and process this first.
		if(readLength > 0) {
			if(data.length < (responsePacketLength - readLength)) {
				data.copy(readBuffer, readLength, 0);
				readLength += data.length;
				return;
			}
			data.copy(readBuffer, readLength, 0, responsePacketLength-readLength);
			decodeResponse(readBuffer, 0);
			pos = responsePacketLength-readLength;
			readLength = 0;
		}
		while(pos<data.length-1) {
			if((data.length-pos) < responsePacketLength) {
				//Buffer remaining data until next time
				data.copy(readBuffer, 0, pos);
				readLength = data.length - pos;
				break;
			}
			decodeResponse(data, pos);
			pos += responsePacketLength;
		}
	}
	
	var decodeResponse = function(data, start) {
		time = bytes2int(data, 4, start);
		start += 4;
		len  = bytes2int(data, 2, start);
		start += 2;
		tok  = new Buffer(len);
		data.copy(tok, 0, start, start+len);
		
		if(typeof options['feedback'] == 'function') {
			options['feedback'](time, new exports.device(tok));
		}
	}
}

function int2buf(number, buffer, start, length) {
	length -= 1;
	for(var i=0; i<=length; i++) {
		buffer[start+length-i] = number & 0xff;
		number = number >> 8;
	}
	return length+1;
}

function bytes2int(bytes, length, start) {
	if(start === undefined) start = 0;
	var num = 0;
	length -= 1;
	for(var i=0; i<=length; i++) {
		num += (bytes[start+i] << ((length - i) * 8));
	}
	return num;
}

function invoke_after(callback) {
	var n = 0;
	return function (delegate) {
		n++;
		return function() {
			delegate.apply(delegate, arguments);
			if(--n == 0) callback();
		};
	};
}

exports.connection = Connection;
exports.notification = Notification;
exports.device = Device;
exports.feedback = Feedback;
exports.error = Errors;