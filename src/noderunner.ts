let MongoClient = require('mongodb').MongoClient,
  ImmediateQueue = require('./queue/immediate'),
  PlannedQueue = require('./queue/planned'),
  HistoryQueue = require('./queue/history'),
  Gui = require('./gui'),
  nconf = require('nconf')

import Watchdog from './watchdog'
import { createLogger } from './logger'

// Config from ENV, CLI, default file and local file
nconf
  .argv()
  .env()
  .file('custom', { file: 'custom/config.json' })
  .file({ file: 'defaults.json' })
  .defaults({ logLevel: 'error' })

// Init logger
var logger = createLogger(nconf.get('logLevel'))

var immediate, planned, history, watchdog, gui

// Mongo connection check
var mongoTimeout
function tryMongoConnection() {
  var options = {
    server: {
      reconnectTries: 100,
      reconnectInterval: 1000,
      socketOptions: { keepAlive: 1, connectTimeoutMS: 30000 }
    },
    replset: { socketOptions: { keepAlive: 1, connectTimeoutMS: 30000 } }
  }
  MongoClient.connect(
    nconf.get('mongoDSN'),
    options,
    function(err, db) {
      if (err) {
        logger.error('Mongo connection error, try in 10 secs. ', err)
        clearTimeout(mongoTimeout)
        mongoTimeout = setTimeout(tryMongoConnection, 3000)
      } else {
        logger.info('Connected to mongo queuerunner DB')

        immediate = new ImmediateQueue(db, nconf, logger).run()
        planned = new PlannedQueue(db, nconf, logger).run()
        history = new HistoryQueue(db, nconf, logger).run()
        watchdog = new Watchdog(db, nconf, logger).run(immediate)
        if (nconf.get('gui:enable')) {
          gui = new Gui(
            db,
            nconf,
            logger,
            {
              immediate: immediate,
              planned: planned,
              history: history
            },
            watchdog
          ).run()
        }
      }
    }
  )
}
tryMongoConnection()

logger.on('logging', function(transport, level, msg, meta) {
  if (level == 'error' && meta.message && meta.message == 'topology was destroyed') {
    logger.warn('MONGO TOPOLOGY DESTRUCTION DETECTED - stopping queues and reconnecting mongo')

    if (nconf.get('gui:enable')) {
      gui.stop()
    }

    planned.stop()
    history.stop()
    watchdog.stop()
    immediate.stop(function() {
      logger.warn('IMMEDIATE: instance with broken mongo just stopped')
    })

    tryMongoConnection()
  }
})

// Graceful restart handler
process.on('SIGABRT', function() {
  var timeout = nconf.get('gracefulShutdownTimeout')
  logger.warn(
    'SHUTDOWN: Graceful shutdown request detected. Stop queues and wait for ' +
      timeout / 1000 +
      ' seconds.'
  )

  if (nconf.get('gui:enable')) {
    gui.stop()
  }

  planned.stop()
  history.stop()
  watchdog.stop()
  immediate.stop(function() {
    logger.warn('SHUTDOWN: Last thread finished. Exitting in 3 secs...')

    // if some db query running, give it some time to finish
    setTimeout(function() {
      process.exit()
    }, 3000)
  })

  setTimeout(function() {
    logger.warn('SHUTDOWN: Graceful shutdown timeout exceeded. Exitting now...')
    process.exit()
  }, timeout)
})
