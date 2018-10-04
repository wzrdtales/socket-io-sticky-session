var net = require('net'),
    cluster = require('cluster'),
    crypto = require('crypto');

module.exports = sticky;

function hash(ip, seed) {
  var hash = ip.reduce(function(r, num) {
    r += parseInt(num, 10);
    r %= 2147483648;
    r += (r << 10);
    r %= 2147483648;
    r ^= r >> 6;
    return r;
  }, seed);

  hash += hash << 3;
  hash %= 2147483648;
  hash ^= hash >> 11;
  hash += hash << 15;
  hash %= 2147483648;

  return hash >>> 0;
}

/**
  * Access 'private' object _handle of file decriptor to republish the read
  * packet.
  *
  * Supports Node versions from 0.9.6 and up.
  */
function node96Republish(fd, data) {
  fd._handle.onread(new Buffer(data), 0, data.length);
}

/**
  * Access 'private' object _handle of file decriptor to republish the read
  * packet.
  *
  * Supports Node version from 0.12 and up.
  */
function node012Republish(fd, data) {
  fd._handle.onread(1, new Buffer(data));
}

/**
  * Hash balanced layer 3 connection listener.
  */
function layer3HashBalancedConnectionListener(c) {
  var self = this;

  // Get int31 hash of ip
  var worker,
      ipHash = hash((c.remoteAddress || '').split(/\./g), self.seed);

  // Pass connection to worker
  worker = self.workers[ipHash % self.workers.length];
  worker.send('sticky-session:connection', c);
}

/**
  * Hash balanced layer 4 connection listener.
  *
  * The node is choosed randomly initial and gets hash balanced later in
  * patchConnection.
  */
function layer4HashBalancedConnectionListener(c) {
  var self = this;

  // Get int31 hash of ip
  var worker,
      random = crypto.randomBytes(4).readUInt32BE(0, true);

  var maxRetries = 15,
    triesNumber = 0;

  // Pass connection to worker
  do {
    worker = self.workers[random % self.workers.length];
    triesNumber++;
  } while(worker.isDead() && triesNumber < maxRetries);

  if (triesNumber >= maxRetries) {
    console.error('Worker not found: all workers are dead');
  }

  worker.send('sticky-session:sync', c);
}

/**
  * Hash balance on the real ip and send data + file decriptor to final node.
  */
function patchConnection(c, fd, agent) {
  // Get int31 hash of ip
  var worker,
      ipHash = hash((c.realIP || '').split(/\./g), agent.seed);

  // Pass connection to worker
  worker = agent.workers[ipHash % agent.workers.length];

  worker.send({
    cmd: 'sticky-session:connection', 
    data: c.data 
  }, fd);
}

/**
 * Handle sending messages to dead worker
 */
function patchWorker(worker) {
  worker.send = (function(original) {
    return function(message, socket) {
      if (this.isDead()) {
        socket.write('Error: worker has been died');
        socket.end();
        
        return;
      }

      original.apply(this, arguments);
    };
  })(worker.send);

  return worker;
}

function sticky(options, callback) {
  var agent = new StickyAgent(options, callback);

  if (cluster.isMaster) {
    return agent.setupMaster();
  } else {
    return agent.setupSlave();
  }
}

function StickyAgent(options, callback) {
  var version = process.version.substr(1);
  var index = version.indexOf('.');
  this.callback = callback;

  this.seed = 0;
  this.header = 'x-forwarded-for';
  this.ignoreMissingHeader = false;
  this.republishPacket = node96Republish;
  this.sync = {
    isSynced: false,
    event: 'sticky-sessions:syn'
  };
  this.serverOptions = {};

  // `num` argument is optional
  if (!callback) {
    this.callback = options;
    this.num = require('os').cpus().length;

    this.connectionListener = layer3HashBalancedConnectionListener;
  } else if (typeof options === 'number') {
    this.num = options;
    this.connectionListener = layer3HashBalancedConnectionListener;
  } else {
    if (typeof options.num === 'number') {
      this.num = options.num;
    } else {
      this.num = require('os').cpus().length;
    }

    /**
      * Set connectionListener to layer4HashBalancedConnectionListener
      * if proxy is set to true.
      */
    if (options.proxy) {
      this.connectionListener = layer4HashBalancedConnectionListener;
    } else {
      this.connectionListener = layer3HashBalancedConnectionListener;
    }

    // still proxy if the x-forwarded-for was not sent; needed for some reverse proxies
    this.ignoreMissingHeader = !!options.ignoreMissingHeader;

    /**
      * Changing the header if user specified something else than
      * 'x-forwarded-for'.
      */
    if (options.header) {
      this.header = options.header.toString().toLowerCase();
    }

    /**
      * Overwriting sync object to sync with users options.
      */
    if (options.sync) {
      this.sync = options.sync;
    }

    if (Number(version.substr(0, index)) >= 1 ||
        Number(version.substr(index + 1)) >= 12) {
      this.serverOptions.pauseOnConnect = true;
      this.republishPacket = node012Republish;
    }
  }
}

StickyAgent.prototype.setupMaster = function() {
  var self = this;

  // Master will spawn `num` workers
  self.workers = [];
  for (var i = 0; i < self.num; i++) {
    !function spawn(i) {
      var worker = patchWorker(cluster.fork());

        // Restart worker on exit
      worker.on('exit', function(code, signal) {
        if (signal) {
          console.log(`sticky-session: worker was killed by signal: ${signal}`);
        } else if (code !== 0) {
          console.log(`sticky-session: worker exited with error code: ${code}`);
        } else {
          console.log('sticky-session: worker died!');
        }

        spawn(i);
      });

      worker.on('error', function() {
        console.error('Worker error', arguments);
      });

      worker.on('message', function(msg, c) {
        if (typeof msg === 'object' && msg.cmd === 'sticky-session:ack') {
          patchConnection(msg, c, self);
        }
      });

      self.workers[i] = worker;
    }(i);
  }

  self.seed = crypto.randomBytes(4).readUInt32BE(0, true) % 0x80000000;
  
  return net.createServer(self.serverOptions, function(c) {
    self.connectionListener(c);
  });
};

StickyAgent.prototype.setupSlave = function() {
  var self = this;

  self.server = typeof self.callback === 'function' ? self.callback() :
    self.callback;

  process.on('message', function(msg, socket) {
    if (socket) { 
      self.listener(msg, socket);
    }
  });

  if (!self.server) {
    throw new Error('Worker hasn\'t created server!');
  }

  // Monkey patch server to do not bind to port
  var oldListen = self.server.listen;
  self.server.listen = function listen() {
    var lastArg = arguments[arguments.length - 1];

    if (typeof lastArg === 'function') {
      lastArg();
    }

    return oldListen.call(this, function() {});
  };

  return self.server;
};

/**
  * Worker process
  */
StickyAgent.prototype.listener = function(msg, socket) {
  var self = this;
  /**
    * Worker received sync flagged request.
    */
  if (msg === 'sticky-session:sync') {
  /**
    * Reading data once from file descriptor and extract ip from the
    * header.
    */
    if (socket) {
      socket.once('data', function(data) {
        var strData = data.toString().toLowerCase(),
            searchPos = strData.indexOf(self.header),
            endPos;

        if (self.serverOptions.pauseOnConnect) {
          socket.pause();
        }

        /**
          * If the header was not found return, probably unwanted behavior.
          */
        if (searchPos === -1) {
          if (self.ignoreMissingHeader) {
            process.send({ 
              cmd: 'sticky-session:ack', 
              realIP: socket.remoteAddress, 
              data: data 
            },
              socket
            );
            
            return;
          } else {
            socket.destroy();
            return;
          }
        }

        searchPos = strData.indexOf(':', searchPos) + 1;

        endPos = strData.indexOf('\n', searchPos);
        strData = strData.substr(searchPos, endPos - searchPos - 1).trim();

        //Send ackknownledge + data and real ip adress back to master
        process.send({ 
          cmd: 'sticky-session:ack', 
          realIP: strData, 
          data: data 
        },
          socket
        );
      });

      if (self.serverOptions.pauseOnConnect) {
        socket.resume();
      }
    }
  }
  /**
    * Message was an object and has to contain a cmd variable.
    */
  else if (typeof msg === 'object') {
    /**
      * Master send us a finalized to us assigned file descriptor
      * and the read data from the ip extraction.
      */
    if (msg.cmd === 'sticky-session:connection') {
      var sync = self.sync;

      /**
        * We register the event, to synchronize the data republishing
        * if the user wants for some reason manually call the sync.
        */
      if (sync.isSynced) {
        socket.once(sync.event, function() {
          self.republishPacket(socket, msg.data);
        });
      }

      self.server.emit('connection', socket);

      /**
        * We're going to push the packet back to the net controller,
        * to let this node complete the original request.
        */
      if (!sync.isSynced) {
        self.republishPacket(socket, msg.data);
      }
    }
  } else if (msg !== 'sticky-session:connection') {
    return;
  } else {
    self.server.emit('connection', socket);
  }
};
