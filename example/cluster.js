var sticky = require('../');
var cluster = require('cluster');
var port = 3000;
var http = require('http');

var createServer = function () {
    return http.createServer(function(req, res) {
      res.writeHead(200, {'Content-Type': 'text/plain'});
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
