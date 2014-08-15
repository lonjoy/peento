/**
 * Peento Application
 *
 * @author Zongmin Lei <leizongmin@gmail.com>
 */

var fs = require('fs');
var path = require('path');
var events = require('events');
var util = require('util');
var async = require('async');
var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var session = require('cookie-session');
var morgan = require('morgan');
var serveStatic = require('serve-static');
var timeout = require('connect-timeout');
var rd = require('rd');
var expressLiquid = require('express-liquid');
var createNamespace = require('lei-ns').Namespace;
var MySQLPool = require('lei-mysql');
var MySQLModel = require('lei-mysql-model');
var Pipe = require('lei-pipe');
var RoutesSort = require('lei-routes-sort');
var FileLookup = require('file-lookup');
var errorhandler = require('./middleware/errorhandler');
var assetsMiddleware = require('./middleware/assets');
var csrfMiddleware = require('./middleware/csrf');
var multipartyMiddleware = require('./middleware/multiparty');
var utils = require('./lib/utils');
var Plugin = require('./lib/plugin');
var createDebug = require('./lib/debug');
var defaultConfig = require('./lib/default_config');
var debug = require('./lib/debug')('app');


function warning (str) {
  console.error('Warning: ' + str);
}

module.exports = function (config) {
  return new PeentoApplication(config);
};

function PeentoApplication (config) {
  debug('new');

  // fill default config
  config = utils.merge(defaultConfig, config || {});

  // init global namespace
  var ns = this.ns = createNamespace();
  ns('app', this);
  ns('config', config);
  ns('utils', utils);
  ns('debug', createDebug);
  ns('middleware.csrf', csrfMiddleware(ns, debug));
  ns('middleware.multiparty', multipartyMiddleware(ns, debug));
  this._is_debug = !!config.debug;
  this._fileLookup = {
    view:  new FileLookup(),
    asset: new FileLookup()
  };

  // init express
  var app = this.express = express();
  app.use(morgan());
  app.use(bodyParser());
  app.use(express.query());
  app.use(cookieParser(config.cookie.secret));
  app.use(session({
    keys: [config.session.secret]
  }));
  app.use('/assets', assetsMiddleware(ns));
  app.use(timeout(config.request.timeout));

  this.router = RoutesSort.create();

  this._initTpl();
}
util.inherits(PeentoApplication, events.EventEmitter);

PeentoApplication.prototype.listen = function (port) {
  debug('listen %s', port);
  this.express.listen(port);
};

PeentoApplication.prototype.start = function () {
  debug('start');
  this._initDb();
  this._initPlugins();
  this._initFilters();
  this._initLocals();
  this.router.register(this.express);
  this.express.use(errorhandler());
  this._loadDefaultViews();
  this.listen(this.ns('config.port'));
  this.emit('start');
};

/******************************************************************************/

PeentoApplication.prototype._loadDefaultViews = function () {
  var views = this.ns('view');
  if (!views['view_not_found.liquid']) {
    views['view_not_found.liquid'] = path.resolve(__dirname, 'view/view_not_found.liquid');
  }
};

PeentoApplication.prototype._usePlugin = function (name, fn) {
  var ns = this.ns;
  var plugin = new Plugin(name, ns);
  ns('plugin.' + name, plugin);
  fn(ns, plugin, plugin.debug);

  if (!Array.isArray(this._plugins)) this._plugins = [];
  this._plugins.push(plugin);

  this._fileLookup.asset.add(path.resolve(plugin.dir, 'asset'));
  this._fileLookup.view.add(path.resolve(plugin.dir, 'view'));
}

PeentoApplication.prototype.use = function (name) {
  var errs = [];
  var m;

  if (typeof name === 'function') {
    m = name;
    name = utils.randomString(8);
  }

  // try to load from working path: ./name
  if (!m) {
    try {
      m = require(path.resolve(name));
    } catch (err) {
      errs.push(err);
    }
  }

  // try to load from package "peento-xxx"
  if (!m) {
    try {
      var n = 'peento-' + name;
      m = require(n);
    } catch (err) {
      errs.push(err);
    }
  }

  if (typeof m !== 'function') {
    throw new Error('Plugin ' + name + ' not found');
  }

  this._usePlugin(name, m);
};

PeentoApplication.prototype._initPlugins = function () {
  debug('_initPlugins');
  if (Array.isArray(this._plugins)) {
    this._plugins.forEach(function (plugin) {
      plugin.init();
    });
  } else {
    warning('no plugin was loaded.');
  }
};

/******************************************************************************/

PeentoApplication.prototype._initTpl = function () {
  debug('_initTpl');
  var me = this;
  var ns = this.ns;
  var app = this.express;

  var baseContext = this.context = expressLiquid.newContext();
  var renderLiquid = this.renderLiquid = expressLiquid({
    context: baseContext,
    resolveFilename: function (name, settings) {
      var ext = path.extname(name);
      if (!ext) name += '.liquid';
      return name;
    },
    includeFile: function (name, callback) {
      var views = ns('view');
      if (name[0] === '/') name = name.slice(1);
      var f = views[name];
      // if is debug mode, try to lookup from view paths
      if (!f && me._is_debug) {
        f = me._fileLookup.view.resolveSync(name);
      }
      // view not found
      if (!f) f = views['view_not_found.liquid'];
      debug('resolve view: [%s] %s', name, f);

      // read file
      fs.readFile(f, {encoding: 'utf8'}, function (err, tpl) {
        if (err) return callback(err);
        callback(null, '{% assign _view_name="' + name.slice(0, -7) + '" %}' + tpl)
      });
    },
    traceError: me._is_debug
  });

  app.use(function (req, res, next) {
    res.context = expressLiquid.newContext();
    res._render = res.render;

    res.render = function (tpl) {
      debug('render: %s', tpl);

      res.context.setLocals('_server', {
        query:  req.query,
        body:   req.body,
        params: req.params,
        headers: req.headers,
        session: req.session
      });
      res.context.setLocals('_config', ns('config'));

      renderLiquid(tpl, {
        context:    res.context,
        cache:      !me._is_debug,
        settings:   {}
      }, function (err, html) {
        if (err) return next(err);
        res.header('content-type', 'text/html');
        res.end(html);
      });
    };

    res.setLocals = function (n, v) {
      return res.context.setLocals(n, v);
    };

    next();
  });
};

PeentoApplication.prototype._initFilters = function () {
  debug('_initFilters');
  var ns = this.ns;
  var baseContext = this.context;
  var filters = ns('filter');
  for (var i in filters) {
    if (i.substr(-5) === 'Async') {
      baseContext.setAsyncFilter(i.substr(0, i.length - 5), filters[i]);
    } else {
      baseContext.setFilter(i, filters[i]);
    }
  }
};

PeentoApplication.prototype._initLocals = function () {
  debug('_initLocals');
  var ns = this.ns;
  var baseContext = this.context;
  var locals = ns('locals');
  for (var i in locals) {
    var item = locals[i];
    baseContext.setAsyncLocals(item.p, item.fn);
  }
};

PeentoApplication.prototype._initDb = function () {
  debug('_initDb');
  var ns = this.ns;
  var db = new MySQLPool(ns('config.mysql'));
  this.db = db;
  ns('db', db);

  var debugSql = createDebug('db:query');
  db.use('sql', function (sql, next) {
    debugSql(sql);
    next(null, sql);
  });
};

/******************************************************************************/

PeentoApplication.prototype._getCallPipe = function (name) {
  this._callPipes = this._callPipes || {};
  this._callPipes[name] = this._callPipes[name] || new Pipe();
  return this._callPipes[name];
};

PeentoApplication.prototype.call = function (name, params, callback) {
  var me = this;
  var ns = me.ns;

  var call = ns('call.' + name);
  if (typeof call !== 'function') {
    return callback(new TypeError('Cannot call ' + name));
  }

  async.series([

    // before.xxxx
    function (next) {
      debug('call: before %s', name);
      var before = me._getCallPipe('before.' + name);
      before.start(params, function (err, data) {
        params = data;
        next(err);
      });
    },

    // xxxx
    function (next) {
      debug('call: %s', name);
      call(params, function (err, data) {
        params = data;
        next(err);
      });
    },

    // after.xxx
    function (next) {
      debug('call: after %s', name);
      var after = me._getCallPipe('after.' + name);
      after.start(params, function (err, data) {
        params = data;
        next(err);
      });
    }

  ], function (err) {
    callback(err, params);
  });
};
