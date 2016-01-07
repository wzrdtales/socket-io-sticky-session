require('longjohn'); // gives long error stacks
var sticky = require('../');
var cluster = require('cluster');
var port = 3000;
var http = require('http');
var net = require('net');

process.on('uncaughtException', function(err) {
    console.error('Uncaught error in worker '
      + (cluster.worker ? cluster.worker.id : 'master')
      + ' ' + err.stack);

    process.exit(1);
})

var createServer = function() {
    return http.createServer(function(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/plain'
        });
        res.end('Hello World! From worker '
          + (cluster.isMaster ? 'master' : cluster.worker.id)
          + ' with pid: ' + process.pid + ' \n');
    });
};

var stickyOptions = {
    proxy: false //activate layer 4 patching
}

var server = sticky(stickyOptions, createServer).listen(port, function() {
    console.log('Sticky cluster worker '
      + (cluster.worker ? cluster.worker.id : 'master')
      + ' server listening on port ' + port);
});


if (cluster.isMaster) { // only need to run one instance of this.

  // hammer sockets
  setInterval(function () {
    var socket = new net.Socket();

    socket.on('error', function (err) { // don't crash on client errors
      console.log('Client-side error (non fatal): ' + err);
    })

    socket.connect({
        port: port,
        host: '127.0.0.1'
    }, function() {
        socket.end(); // immediately close socket
    })

  }, 0);
}
