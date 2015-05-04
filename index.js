"use strict";

var constants = require("constants"),
    fs = require("fs"),
    http = require("http"),
    path = require("path"),
    url = require("url"),
    util = require("util");

var clone = require("clone"),
    handlebars = require("handlebars"),
    omnivore = require("mapnik-omnivore"),
    request = require("request"),
    retry = require("retry"),
    tmp = require("tmp");

var meta = require("./package.json"),
    NAME = meta.name,
    VERSION = meta.version;

http.globalAgent.maxSockets = Infinity;
tmp.setGracefulCleanup();

// treat the following signals as normal exits (allowing tmp to clean up after
// itself)
["SIGINT", "SIGTERM"].forEach(function(signal) {
  process.on(signal, function() {
    process.exit(128 + constants[signal]);
  });
});


var PREFIX = "raster+",
    STYLESHEET = handlebars.compile(fs.readFileSync(path.join(__dirname, "stylesheet.xml.hbs"), {
      encoding: "utf8"
    }));

var fetch = function(uri, headers, callback) {
  var operation = retry.operation({
    retries: 2,
    minTimeout: 10,
    factor: 1
  });

  return operation.attempt(function() {
    return request.get({
      uri: uri,
      encoding: null,
      headers: headers,
      timeout: 30e3
    }, function(err, rsp, body) {
      if (operation.retry(err)) {
        return null;
      }

      if (err) {
        return callback(operation.mainError());
      }

      switch (rsp.statusCode) {
      case 200:
      case 403:
      case 404:
        return callback(null, rsp, body);

      default:
        err = new Error("Upstream error:" + rsp.statusCode);

        if (rsp.statusCode.toString().slice(0, 1) !== "5") {
          return callback(err);
        }

        if (!operation.retry(err)) {
          return callback(operation.mainError(), rsp, body);
        }
      }
    });
  });
};

module.exports = function(tilelive) {
  var loadLocal = function(uri, callback) {
    var filename = path.resolve(path.join(uri.host, uri.pathname));

    // determine metadata
    return omnivore.digest(filename, function(err, metadata) {
      if (err) {
        return callback(err);
      }

      var xml = STYLESHEET({
        extent: metadata.extent.join(", "),
        center: metadata.center.join(", "),
        zoom: Math.min(metadata.minzoom + 3, metadata.maxzoom),
        minzoom: metadata.minzoom,
        maxzoom: metadata.maxzoom,
        projection: metadata.projection,
        nodata: metadata.raster.nodata,
        filename: filename
      });

      // load tilelive-mapnik w/ a populated stylesheet
      return tilelive.load({
        protocol: "mapnik:",
        pathname: filename,
        query: uri.query,
        xml: xml
      }, callback);
    });
  };

  // fetch a remotely hosted raster file and save it to a temporary file so
  // that it can be treated as a local source
  var loadRemote = function(uri, callback) {
    var headers = {
      "User-Agent": [NAME, VERSION].join("/")
    };

    var sourceUrl = url.format(uri);

    return fetch(sourceUrl, headers, function(err, rsp, body) {
      if (err) {
        return callback(err);
      }

      if (rsp.statusCode !== 200) {
        return callback(new Error(util.format("Received %d response for %s", rsp.statusCode, sourceUrl)));
      }

      return tmp.file({
        postfix: path.extname(uri.pathname)
      }, function(err, filename, fd, cleanup) {
        if (err) {
          return callback(err);
        }

        return fs.write(fd, body, 0, body.length, null, function(err) {
          if (err) {
            return callback(err);
          }

          // recursively load the fetched image w/ raster+file: protocol
          return tilelive.load({
            protocol: PREFIX + "file:",
            host: "",
            pathname: filename,
            query: uri.query
          }, function(err, source) {
            if (err) {
              return callback(err);
            }

            var _close = source.close || function(cb) {
              return setImmediate(cb);
            };

            source.close = function() {
              // cleanup temporary files
              cleanup();

              return _close.apply(source, arguments);
            };

            return callback(null, source);
          });
        });
      });
    });
  };

  var RasterSource = function(uri, callback) {
    if (typeof(uri) === "string") {
      uri = url.parse(uri, true);
    } else {
      uri = clone(uri);
    }

    uri.protocol = uri.protocol.replace(PREFIX, "");

    switch (uri.protocol) {
      case "http:":
      case "https:":
        return loadRemote(uri, callback);

      case "file:":
        return loadLocal(uri, callback);

      default:
        return callback(new Error(util.format("Unsupported %s transport: %s", NAME, url.format(uri))));
    }
  };

  RasterSource.registerProtocols = function(_tilelive) {
    _tilelive.protocols[PREFIX + "file:"] = RasterSource;
    _tilelive.protocols[PREFIX + "http:"] = RasterSource;
    _tilelive.protocols[PREFIX + "https:"] = RasterSource;
  };

  RasterSource.registerProtocols(tilelive);

  return RasterSource;
};
