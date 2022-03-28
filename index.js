import { spawnSync } from 'child_process'
import brotliSize from 'brotli-size'
import esbuild from 'esbuild'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'path'

export class Build {
  /**
   * Contains the `esbuild` and (fake) `tsc` results with errors.
   *
   * @type {{errors:string[]}}
   */
  results = []

  /**
   * Whether the `--watch` argument is provided in the current command.
   *
   * @type {boolean}
   */
  watch = process.argv.includes('--watch')

  /**
   * Whether the builder has finished the initial build and is now waiting
   * for file changes if the watch mode is enabled.
   *
   * @type {boolean}
   */
  rebuilding = false

  /**
   * You can mark a file or a package as external to exclude it from your build.
   * Instead of being bundled, the import will be preserved (using require for
   * the iife and cjs formats and using import for the esm format) and will be
   * evaluated at run time instead.
   *
   * @type {string[]}
   */
  external = []

  /**
   * A function that is called after a successful build.
   *
   * @param {*} data Promise return data
   */
  onBuild = async (data) => data

  /**
   * A function that is called after a successful rebuild.
   *
   * @param {*} data Promise return data
   */
  onRebuild = async (data) => data

  /**
   * @param {string} outName The basename of the build files
   * @param {string} cwd Path of the current working directory
   */
  constructor(outName, cwd = '') {
    this.outName = outName
    this.cwd = cwd.replace(/([^\/])$/, '$1/')

    // Get package name from package.json
    this.packageName = path.basename(`${process.cwd()}/${this.cwd}`)

    // Create source file paths
    this.browserJsPath = `${this.cwd}builds/browser.js`
    this.browserTsPath = `${this.cwd}builds/browser.ts`
    this.moduleJsPath = `${this.cwd}builds/module.js`
    this.moduleTsPath = `${this.cwd}builds/module.ts`
    this.srcJsPath = `${this.cwd}src/index.js`
    this.srcTsPath = `${this.cwd}src/index.ts`

    // Check if the source paths exist
    this.browserJsPathExists = fs.existsSync(this.browserJsPath)
    this.browserTsPathExists = fs.existsSync(this.browserTsPath)
    this.moduleJsPathExists = fs.existsSync(this.moduleJsPath)
    this.moduleTsPathExists = fs.existsSync(this.moduleTsPath)
    this.srcJsPathExists = fs.existsSync(this.srcJsPath)
    this.srcTsPathExists = fs.existsSync(this.srcTsPath)
    this.tsConfigExists = fs.existsSync(`${this.cwd}tsconfig.json`)

    // Bind `this`
    this.pushResult = this.pushResult.bind(this)
    this.buildCallback = this.buildCallback.bind(this)
    this.resultsCallback = this.resultsCallback.bind(this)
    this.emptyResultsCallback = this.emptyResultsCallback.bind(this)
    this.sizesCallback = this.sizesCallback.bind(this)
  }

  /**
   * Start building.
   */
  run() {
    fs.emptyDirSync(`${this.cwd}dist`)

    if (this.tsConfigExists) {
      fs.emptyDirSync(`${this.cwd}types`)
    }

    if (
      (this.browserJsPathExists && this.moduleJsPathExists) ||
      (this.browserTsPathExists && this.moduleTsPathExists)
    ) {
      this.buildFrontEnd()
    } else if (this.srcJsPath || this.srcTsPath) {
      this.buildBackEnd()
    } else {
      console.log(chalk.red('✖'), `Cannot to find entry files`)
      console.log('')
    }
  }

  buildFrontEnd() {
    if (this.watch) {
      this.buildBrowser(false, (error) => {
        if (!error) {
          Promise.all([this.buildEsm(), this.buildCjs()])
            .then(this.onRebuild)
            .then(this.resultsCallback)
        }
      })
        .then(async (result) => {
          await Promise.all([this.buildEsm(), this.buildCjs()])
            .then(this.onBuild)
            .then(this.resultsCallback)

          return result
        })
        .finally(this.buildCallback)
    } else {
      const builds = [
        this.buildBrowser(false),
        this.buildBrowser(true),
        this.buildEsm(),
        this.buildCjs(),
      ]

      if (this.moduleTsPathExists) {
        builds.push(this.buildTypes())
      }

      Promise.all(builds)
        .then(this.onBuild)
        .then(this.resultsCallback)
        .then(this.sizesCallback)
        .finally(this.buildCallback)
    }
  }

  buildBackEnd() {
    const esm = !!JSON.parse(fs.readFileSync(`${this.cwd}package.json`, 'utf8')).module

    if (this.watch) {
      this.buildCjs(esm ? 'cjs.js' : 'cjs', (error) => {
        if (!error) {
          const builds = []

          if (esm) {
            builds.push(this.buildEsm())
          }

          if (this.tsConfigExists) {
            builds.push(this.buildTypes())
          }

          Promise.all(builds).then(this.onRebuild).then(this.resultsCallback)
        }
      })
        .then(async (result) => {
          const builds = []

          if (esm) {
            builds.push(this.buildEsm())
          }

          if (this.tsConfigExists) {
            builds.push(this.buildTypes())
          }

          await Promise.all(builds).then(this.onBuild).then(this.resultsCallback)

          return result
        })
        .finally(this.buildCallback)
    } else {
      const builds = [this.buildCjs(esm ? 'cjs.js' : 'cjs')]

      if (esm) {
        builds.push(this.buildEsm())
      }

      if (this.tsConfigExists) {
        builds.push(this.buildTypes())
      }

      Promise.all(builds)
        .then(this.onBuild)
        .then(this.resultsCallback)
        .then(this.sizesCallback)
        .finally(this.buildCallback)
    }
  }

  async buildBrowser(minify, onRebuild) {
    return esbuild
      .build({
        entryPoints: [this.browserJsPathExists ? this.browserJsPath : this.browserTsPath],
        outfile: `${this.cwd}dist/${this.outName}${minify ? '.min' : ''}.js`,
        bundle: true,
        minify,
        watch: onRebuild ? { onRebuild } : false,
        platform: 'browser',
        sourcemap: true,
        mainFields: ['module', 'main'],
      })
      .then(this.pushResult)
  }

  async buildEsm() {
    return esbuild
      .build({
        entryPoints: this.getModuleEntryPoints(),
        outfile: `${this.cwd}dist/${this.outName}.esm.js`,
        bundle: true,
        platform: 'neutral',
        mainFields: ['module', 'main'],
      })
      .then(this.pushResult)
  }

  async buildCjs(extension = 'cjs.js', onRebuild) {
    return esbuild
      .build({
        entryPoints: this.getModuleEntryPoints(),
        outfile: `${this.cwd}dist/${this.outName}.${extension}`,
        bundle: true,
        watch: onRebuild ? { onRebuild } : false,
        platform: 'node',
        target: ['node16'],
        mainFields: ['module', 'main'],
        external: this.external,
      })
      .then(this.pushResult)
  }

  buildTypes() {
    const spawnOptions = { shell: true, stdio: 'inherit' }

    if (this.cwd) {
      spawnOptions.cwd = this.cwd
    }

    const child = spawnSync('tsc', spawnOptions)

    if (child.status === 0) {
      this.results.push({ errors: [] })
    } else {
      this.results.push({ errors: [child.error] })
    }
  }

  pushResult(result) {
    this.results.push(result)
    return result
  }

  buildCallback() {
    this.rebuilding = true

    if (process.send) {
      process.send('build:done')
    }
  }

  resultsCallback(data) {
    if (this.hasErrors()) {
      console.log(
        chalk.red('✖'),
        `${this.rebuilding ? 'Rebuild' : 'Build'} failed: ${chalk.red.bold(this.packageName)}`,
      )

      this.results
        .filter((result) => result.errors.length)
        .reduce((errors, result) => {
          errors.push(...result.errors)
          return errors
        }, [])
        .forEach((error, i) =>
          console.log(`  ${chalk.red.bold(`Error ${i + 1}:`)} ${error?.toString() ?? '(unknown)'}`),
        )
    } else {
      console.log(
        chalk.green('✔'),
        `${this.rebuilding ? 'Rebuild' : 'Build'} successful: ${chalk.green.bold(
          this.packageName,
        )}`,
      )
    }

    if (this.watch) {
      console.log(chalk.blueBright.italic(`  Waiting for changes...`))
    }

    console.log('')

    return data
  }

  emptyResultsCallback(data) {
    this.results.splice(0, this.results.length)
    return data
  }

  sizesCallback(data) {
    if (!this.hasErrors()) {
      this.clearPrevLines(1)

      fs.readdirSync(`${this.cwd}dist`).forEach((file) => {
        if (file.endsWith('.js') || file.endsWith('.cjs')) {
          console.log(`  ${chalk.bold(`dist/${file}`)}: ${chalk.gray('calculating size...')}`)
          const size = this.outputSize(`${this.cwd}dist/${file}`)
          this.clearPrevLines(1)
          console.log(`  ${chalk.bold(`dist/${file}`)}:`, chalk.gray(size))
        }
      })

      console.log('')
    }

    return data
  }

  getModuleEntryPoints() {
    if (this.moduleJsPathExists) {
      return [this.moduleJsPath]
    } else if (this.moduleTsPathExists) {
      return [this.moduleTsPath]
    } else if (this.srcJsPathExists) {
      return [this.srcJsPath]
    } else if (this.srcTsPathExists) {
      return [this.srcTsPath]
    } else {
      return []
    }
  }

  /**
   * Check recent build status.
   *
   * @returns {boolean} Whether the recent build has errors
   */
  hasErrors() {
    return this.results.some((result) => result.errors.length)
  }

  /**
   * Get the brotli compressed size of a string or buffer.
   *
   * @param {string} file The file path
   * @returns {string} The size string
   */
  outputSize(file) {
    return this.bytesToSize(brotliSize.sync(fs.readFileSync(file)))
  }

  /**
   * Convert number of bytes into a human readable format.
   *
   * @param {number} bytes Number of bytes
   * @returns {string} The formatted size string
   */
  bytesToSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']

    if (bytes === 0) {
      return 'n/a'
    }

    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10)

    if (i === 0) {
      return `${bytes} ${sizes[i]}`
    }

    return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`
  }

  /**
   * Clear the previous output line.
   *
   * @param {number} n Number of lines to clear
   */
  clearPrevLines(n) {
    process.stdout.moveCursor(0, -n)
    process.stdout.clearLine(1)
  }
}
