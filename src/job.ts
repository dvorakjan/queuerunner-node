import chance = require('chance')
import parser = require('cron-parser')

export default class JobClass {
  public document: any

  private db: any
  private nconf: any
  private logger: any
  private queue: any
  private threadName: string
  private threadIndex: any

  constructor(queue) {
    this.db = queue.db
    this.nconf = queue.nconf
    this.logger = queue.logger
    this.queue = queue
  }

  public run(callback, fallback, onStatusSaved) {
    const command = this._buildCommandArray()
    this.threadName = this._buildThreadName(this.document.thread)
    this.threadIndex = this.document.thread

    this.logger.info(
      'THREAD ' +
        this.threadName +
        ' ' +
        this.queue.getThreadsInfo(this.threadIndex) +
        ' running ' +
        /*self.toString()*/ this.document._id
    )

    this._save(
      {
        executedCommand: command[0] + ' ' + command[1].join(' '),
        status: this.nconf.get('statusAlias:running')
      },
      function(document) {
        if (typeof onStatusSaved !== 'undefined') {
          onStatusSaved(document)
        }

        const spawn = require('child_process').spawn
        const child = spawn(command[0], command[1])

        this._save({
          pid: child.pid
        })

        child.stdout.on('data', function(data) {
          // TODO dodelat buffer, aby se nevolalo mongo pri kazdem radku
          // self.logger.verbose('THREAD ' + self.threadName + ': data ', data.toString().replace('\n', ' '));
          this._appendToProperty('output', data.toString())
        })
        child.stderr.on('data', function(data) {
          this.logger.warn(
            'THREAD ' + this.threadName + ': error ',
            data.toString().replace('\n', ' ')
          )
          this._appendToProperty('errors', data.toString())
        })
        child.on('exit', function(code) {
          this._finish(code, callback, fallback)
        })
      },
      () => {
        if (typeof fallback !== 'undefined') {
          fallback()
        }
      }
    )
  }

  // parameters and all calculations are in seconds
  public isDue(checkIntervalStart, checkIntervalEnd) {
    // load distribution algorithm - for example when using */10 * * * * schedule, every job should run in any minute in interval 0..9 (but every job every time with the same offset - derieved from its ID)
    let offset
    const parsedSchedule = /\*\/(\d*)( \*){4}/.exec(this.document.schedule)
    if (parsedSchedule && parsedSchedule[1]) {
      const minutesInterval = parseInt(parsedSchedule[1], 10)

      // find random number derived from job id in interval (0..minutesInterval)
      const randomGenerator = new chance(this.document._id.toString())
      offset = Math.round(
        randomGenerator.integer({ min: 0, max: (minutesInterval - 1) * 100 }) * 0.6
      )
    } else {
      offset = 0
    }

    // next() returns next due time, so we need to move time back by one check interval to get current due time
    const now = new Date()
    const next = parser
      .parseExpression(this.document.schedule, {
        currentDate: now.valueOf() - this.nconf.get('planned:interval')
      })
      .next()
    const nextWithoutOffset = Math.floor(next.valueOf() / 1000)
    const nextWithOffset = nextWithoutOffset - offset

    function time(timestamp) {
      const date = new Date(timestamp * 1000)
      return date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds()
    }

    if (checkIntervalStart < nextWithOffset) {
      if (nextWithOffset <= checkIntervalEnd) {
        // inside of interval
        this.logger.debug(
          '✓ job ' +
            this.document._id +
            ' with next due time ' +
            time(nextWithoutOffset) +
            '-' +
            offset +
            's=' +
            time(nextWithOffset) +
            ' is inside of check interval: (' +
            time(checkIntervalStart) +
            '..[' +
            time(nextWithOffset) +
            ']..' +
            time(checkIntervalEnd) +
            '>'
        )
      } else {
        // after interval
        this.logger.debug(
          '✗ job ' +
            this.document._id +
            ' with next due time ' +
            time(nextWithoutOffset) +
            '-' +
            offset +
            's=' +
            time(nextWithOffset) +
            ' is after check interval: (' +
            time(checkIntervalStart) +
            '..' +
            time(checkIntervalEnd) +
            '>  ' +
            (nextWithOffset - checkIntervalStart) +
            's  [' +
            time(nextWithOffset) +
            ']'
        )
      }
    } else {
      // before interval
      this.logger.debug(
        '✗ job ' +
          this.document._id +
          ' with next due time ' +
          time(nextWithoutOffset) +
          '-' +
          offset +
          's=' +
          time(nextWithOffset) +
          ' is before check interval: [' +
          time(nextWithOffset) +
          ']  ' +
          (checkIntervalStart - nextWithOffset) +
          's  (' +
          time(checkIntervalStart) +
          '..' +
          time(checkIntervalEnd) +
          '>'
      )
    }

    return checkIntervalStart < nextWithOffset && nextWithOffset <= checkIntervalEnd
  }

  public copyToImmediate(callback) {
    const newDocument = this.document
    newDocument.sourceId = newDocument._id
    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned')
    newDocument.added = new Date().getTime() / 1000
    this.logger.silly('copyToImmediate')
    this.db.collection('immediate').insert(newDocument, () => {
      this.logger.silly('copyToImmediate DONE')
      // self.queue.emit('copiedToImmediate', {oldDocument: self.document, newDocument: newDocument});
      callback()
    })
  }

  public moveToHistory() {
    const newDocument = this.document
    this.db.collection('immediate').remove({ _id: newDocument._id })
    delete newDocument._id
    this.logger.silly('moveToHistory')
    this.db.collection('history').insert(newDocument, () => {
      this.logger.silly('moveToHistory DONE')
      // self.queue.emit('movedToHistory', {oldDocument: self.document, newDocument: newDocument});
    })
  }

  public rerun() {
    const newDocument = this.document

    delete newDocument._id
    newDocument.status = this.nconf.get('statusAlias:planned')
    newDocument.added = new Date().getTime() / 1000
    newDocument.output = ''
    newDocument.errors = ''
    this.logger.debug('rerun')
    this.db.collection('immediate').insert(newDocument, () => {
      this.logger.debug('rerun DONE')
      this.queue.emit('rerunDone', { oldDocument: this.document, newDocument })
    })
  }

  public initByDocument(doc) {
    this.document = doc
  }

  public toString() {
    return this.document._id + ' ' + this._buildCommand()
  }

  private _finish(code, callback, fallback) {
    const finished = new Date().getTime() / 1000

    if (code === 0) {
      this._save({ status: this.nconf.get('statusAlias:success'), finished }, callback, fallback)
      this.logger.info(
        'THREAD ' +
          this.threadName +
          ' ' +
          this.queue.getThreadsInfo(this.threadIndex) +
          '  -> ' +
          this.document._id +
          ' done with SUCCESS'
      )
    } else {
      this._save({ status: this.nconf.get('statusAlias:error'), finished }, callback, fallback)
      this.logger.warn(
        'THREAD ' +
          this.threadName +
          ' ' +
          this.queue.getThreadsInfo(this.threadIndex) +
          '  -> ' +
          this.document._id +
          ' done with ERROR, status ' +
          code
      )
    }
  }

  private _appendToProperty(property, value) {
    if (this.document[property] === null || typeof this.document[property] === 'undefined') {
      this.document[property] = value
    } else {
      this.document[property] += value
    }

    const data = {}
    data[property] = this.document[property]
    this._save(data)
  }

  private _save(data, callback?, fallback?) {
    this.db
      .collection('immediate')
      .findAndModify({ _id: this.document._id }, [], { $set: data }, { new: true }, (err, doc) => {
        if (err || doc === null) {
          this.logger.error(
            'THREAD ' + this.threadName + ':',
            'cannot save document',
            err,
            doc !== null ? doc.value : ''
          )
          if (typeof fallback !== 'undefined') {
            fallback(err)
          }
        } else {
          if (typeof callback !== 'undefined') {
            callback(doc.value)
          }
        }
      })
  }

  private _buildCommandArray() {
    return this._buildCommand(true)
  }

  private _buildCommand(returnAsArray = false) {
    let args =
      this.nconf.get('sudo:user') && this.nconf.get('sudo:user').length > 0
        ? ['sudo', '-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')]
        : []

    args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : [])

    // if we had command property, use it instead of deprecated interpreter, basepath, executable, args
    if (this._hasProperty('command')) {
      args = args.concat(this.document.command.split(' '))
    } else {
      args = args.concat(this._hasProperty('interpreter') ? [this.document.interpreter] : [])
      if (this._hasProperty('basePath') && this.document.basePath.length > 0) {
        let path = this.document.basePath + '/'
        if (this._hasProperty('executable')) {
          path += this.document.executable
        }
        args.push(path)
      }
      args = args.concat(this._hasProperty('args') ? this.document.args.split(' ') : [])
    }

    const exe = args.shift()

    if (typeof returnAsArray === 'undefined' || !returnAsArray) {
      return exe + ' ' + args.join(' ')
    } else {
      return [exe, args]
    }
  }

  private _buildThreadName(threadIndex) {
    let name = '#' + (threadIndex + 1)

    const threadNames = this.nconf.get('debug:threadNames')
    if (threadNames) {
      name = threadNames[threadIndex]
    }

    return name
  }

  private _hasProperty(prop) {
    return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null
  }
}
