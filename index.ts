import * as webpack from 'webpack'
import * as Promise from 'bluebird'
import * as events from 'events'
import merge from 'webpack-merge'

import { createDeferred } from './deferred'

const path = require('path')
const debug = require('debug')('cypress:webpack')
const debugStats = require('debug')('cypress:webpack:stats')

const stubbableRequire = require('./stubbable-require')

type FilePath = string

// bundle promises from input spec filename to output bundled file paths
let bundles: {[key: string]: Promise<FilePath>} = {}

// we don't automatically load the rules, so that the babel dependencies are
// not required if a user passes in their own configuration
const getDefaultWebpackOptions = (): webpack.Configuration => {
  debug('load default options')

  return {
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: [/node_modules/],
          use: [
            {
              loader: stubbableRequire.resolve('babel-loader'),
              options: {
                presets: [stubbableRequire.resolve('@babel/preset-env')],
              },
            },
          ],
        },
      ],
    },
  }
}

// We need to do this at times to support things like source maps
const getCypressWebpackOverrides = (): webpack.Configuration => {
  debug('load cypress overrides')
  
  return {
    devtool: 'inline-source-map',
    module: {
      rules: [
        test: /\.tsx?$/,
        exclude: [/node_modules/],
        use: [
          {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                sourceMap: true,
                inlineSourceMap: false,
                // the other source map option
              }
            }
          }
        ]
      ]
    }
  }
}

/**
 * Configuration object for this Webpack preprocessor
 */
interface PreprocessorOptions {
  webpackOptions?: webpack.Configuration
  watchOptions?: Object
  additionalEntries?: string[]
}

interface FileEvent extends events.EventEmitter {
  filePath: FilePath
  outputPath: string
  shouldWatch: boolean
}

/**
 * Cypress asks file preprocessor to bundle the given file
 * and return the full path to produced bundle.
 */
type FilePreprocessor = (file: FileEvent) => Promise<FilePath>

type WebpackPreprocessorFn = (options: PreprocessorOptions) => FilePreprocessor

interface WebpackPreprocessor extends WebpackPreprocessorFn {
  defaultOptions: Omit<PreprocessorOptions, 'additionalEntries'>
}

/**
 * Webpack preprocessor configuration function. Takes configuration object
 * and returns file preprocessor.
 * @example
  ```
  on('file:preprocessor', webpackPreprocessor(options))
  ```
 */
// @ts-ignore
const preprocessor: WebpackPreprocessor = (options: PreprocessorOptions = {}): FilePreprocessor => {
  debug('user options:', options)

  // we return function that accepts the arguments provided by
  // the event 'file:preprocessor'
  //
  // this function will get called for the support file when a project is loaded
  // (if the support file is not disabled)
  // it will also get called for a spec file when that spec is requested by
  // the Cypress runner
  //
  // when running in the GUI, it will likely get called multiple times
  // with the same filePath, as the user could re-run the tests, causing
  // the supported file and spec file to be requested again
  return (file: FileEvent) => {
    const filePath = file.filePath

    debug('get', filePath)

    // since this function can get called multiple times with the same
    // filePath, we return the cached bundle promise if we already have one
    // since we don't want or need to re-initiate webpack for it
    if (bundles[filePath]) {
      debug(`already have bundle for ${filePath}`)

      return bundles[filePath]
    }

    // user can override the default options
    const userDefinedWebpackOptions: webpack.Configuration = options.webpackOptions || getDefaultWebpackOptions()
    const cypressOverrides = getCypressWebpackOverrides()
    let webpackOptions = merge.smartStrategy({
      'module.rules': 'append'
    })(userDefinedWebpackOptions, cypressOverrides)

    const watchOptions = options.watchOptions || {}

    debug('webpackOptions: %o', webpackOptions)
    debug('watchOptions: %o', watchOptions)

    const entry = [filePath].concat(options.additionalEntries || [])
    // we're provided a default output path that lives alongside Cypress's
    // app data files so we don't have to worry about where to put the bundled
    // file on disk
    const outputPath = path.extname(file.outputPath) === '.js'
      ? file.outputPath
      : `${file.outputPath}.js`

    // we need to set entry and output
    // TODO:  move this into webpack-merge
    webpackOptions = Object.assign(webpackOptions, {
      entry,
      output: {
        path: path.dirname(outputPath),
        filename: path.basename(outputPath),
      },
    })

    debug(`input: ${filePath}`)
    debug(`output: ${outputPath}`)

    const compiler = webpack(webpackOptions)

    // we keep a reference to the latest bundle in this scope
    // it's a deferred object that will be resolved or rejected in
    // the `handle` function below and its promise is what is ultimately
    // returned from this function
    let latestBundle = createDeferred<string>()

    // cache the bundle promise, so it can be returned if this function
    // is invoked again with the same filePath
    bundles[filePath] = latestBundle.promise

    const rejectWithErr = (err: Error) => {
      // @ts-ignore
      err.filePath = filePath
      debug(`errored bundling ${outputPath}`, err.message)

      latestBundle.reject(err)
    }

    // this function is called when bundling is finished, once at the start
    // and, if watching, each time watching triggers a re-bundle
    const handle = (err: Error, stats: webpack.Stats) => {
      if (err) {
        debug('handle - had error', err.message)

        return rejectWithErr(err)
      }

      const jsonStats = stats.toJson()

      if (stats.hasErrors()) {
        err = new Error('Webpack Compilation Error')

        const errorsToAppend = jsonStats.errors
        // remove stack trace lines since they're useless for debugging
        .map(cleanseError)
        // multiple errors separated by newline
        .join('\n\n')

        err.message += `\n${errorsToAppend}`

        debug('stats had error(s)')

        return rejectWithErr(err)
      }

      // these stats are really only useful for debugging
      if (jsonStats.warnings.length > 0) {
        debug(`warnings for ${outputPath}`)
        debug(jsonStats.warnings)
      }

      debug('finished bundling', outputPath)
      if (debugStats.enabled) {
        /* eslint-disable-next-line no-console */
        console.error(stats.toString({ colors: true }))
      }

      // resolve with the outputPath so Cypress knows where to serve
      // the file from
      latestBundle.resolve(outputPath)
    }

    // this event is triggered when watching and a file is saved
    const plugin = { name: 'CypressWebpackPreprocessor' }

    const onCompile = () => {
      debug('compile', filePath)
      // we overwrite the latest bundle, so that a new call to this function
      // returns a promise that resolves when the bundling is finished
      latestBundle = createDeferred<string>()
      bundles[filePath] = latestBundle.promise

      bundles[filePath].finally(() => {
        debug('- compile finished for', filePath)
        // when the bundling is finished, emit 'rerun' to let Cypress
        // know to rerun the spec
        file.emit('rerun')
      })
      // we suppress unhandled rejections so they don't bubble up to the
      // unhandledRejection handler and crash the process. Cypress will
      // eventually take care of the rejection when the file is requested.
      // note that this does not work if attached to latestBundle.promise
      // for some reason. it only works when attached after .tap  ¯\_(ツ)_/¯
      .suppressUnhandledRejections()
    }

    // when we should watch, we hook into the 'compile' hook so we know when
    // to rerun the tests
    if (file.shouldWatch) {
      debug('watching')

      if (compiler.hooks) {
        // TODO compile.tap takes "string | Tap"
        // so seems we just need to pass plugin.name
        // @ts-ignore
        compiler.hooks.compile.tap(plugin, onCompile)
      } else {
        compiler.plugin('compile', onCompile)
      }
    }

    const bundler = file.shouldWatch ? compiler.watch(watchOptions, handle) : compiler.run(handle)

    // when the spec or project is closed, we need to clean up the cached
    // bundle promise and stop the watcher via `bundler.close()`
    file.on('close', (cb = function () {}) => {
      debug('close', filePath)
      delete bundles[filePath]

      if (file.shouldWatch) {
        // in this case the bundler is webpack.Compiler.Watching
        (bundler as webpack.Compiler.Watching).close(cb)
      }
    })

    // return the promise, which will resolve with the outputPath or reject
    // with any error encountered
    return bundles[filePath]
  }
}

// provide a clone of the default options, lazy-loading them
// so they aren't required unless the user utilizes them
Object.defineProperty(preprocessor, 'defaultOptions', {
  get () {
    debug('get default options')

    return {
      webpackOptions: getDefaultWebpackOptions(),
      watchOptions: {},
    }
  },
})

// for testing purposes, but do not add this to the typescript interface
// @ts-ignore
preprocessor.__reset = () => {
  bundles = {}
}

function cleanseError (err: string) {
  return err.replace(/\n\s*at.*/g, '').replace(/From previous event:\n?/g, '')
}

export = preprocessor
