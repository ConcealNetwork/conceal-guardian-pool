// redisDemo.js
const bodyParser = require("body-parser");
const NodeCache = require( "node-cache" );
const express = require("express");
const config = require('./config.json');
const https = require('https');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

var nodeCache = new NodeCache( { stdTTL: config.cache.expire, checkperiod: config.cache.checkPeriod } ); // the cache object
var app = express(); // create express app
// use the json parser for body
app.use(bodyParser.json());
app.use(cors());

// use HTTPS (SSL)
https.createServer({
    key: fs.readFileSync(path.join(path.dirname(require.main.filename), 'certificates/key.pem')),
    cert: fs.readFileSync(path.join(path.dirname(require.main.filename), 'certificates/cert.pem')),
    passphrase: 'Ke2hK7c22umZ64Tv'
}, app).listen(config.server.port, () => { 
    console.log("HTTPS Server running on port " + config.server.port); 
});

// get request for the list of all active nodes
app.get("/pool/list", (req, res, next) => {
    nodeCache.keys( function( err, keys ) {
        if( !err ) {
            var nodeList = [];

            keys.forEach(function(value) {
                nodeList.push(nodeCache.get(value));
            }); 

            // return the list
            res.json({ "success": true, "list": nodeList });
        } else {
            res.json({ "success": false, "list": [] });
        }
    });
});

// post request for updating the node data
app.post("/pool/update", (req, res, next) => {
    if (req.body) {
        req.body.ip = req.header('x-forwarded-for') || req.connection.remoteAddress;
        res.json({ "success": nodeCache.set(req.body.id, req.body, 600) });    
    }
});

// handle any application errors
app.use(function (err, req, res, next) {
    if (err) {
        next(err);
    }
});