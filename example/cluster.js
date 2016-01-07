var sticky = require('../');
var cluster = require('cluster');
var port = 3000;
var http = require('http');
// var io = require('socket.io');

var options = {
  proxy: false, //activate layer 4 patching
  // header: 'x-forwarded-for', //provide here your header containing the users ip
  // num: 2, //count of processes to create, defaults to maximum if omitted
  // sync: {
  //   isSynced: true, //activate synchronization
  //   event: 'mySyncEventCall' //name of the event you're going to call
  // }
}

var server = sticky(options, function() {
  // This code will be executed only in slave workers
  var server = http.createServer(function(req, res) {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('Hello World! From worker: ' + (cluster.isMaster ? 'master' : cluster.worker.id) + ' with pid: ' + process.pid + ' \n');
  });
  // io.listen(server);

  return server;
}).listen(port, function() {
    console.log('Sticky cluster worker ' + (cluster.worker ? cluster.worker.id : 'master') + ' server listening on port ' + port);
});
