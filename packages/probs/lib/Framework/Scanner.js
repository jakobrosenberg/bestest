import { readdir, stat } from 'fs/promises'
import { resolve } from 'path'
import picomatch from 'picomatch'
import { importCfg } from '../utils/misc.js'
import { scopeMatchesPattern } from './TestRunner/utils/index.js'

export class Dir {
    _files = []
    /** @type {File[]} */
    testFiles = []
    /** @type {Dir[]} */
    dirs = []
    options = {}

    /**
     * @param {import('./Probs').Probs} probs
     * @param {string} path
     * @param {Dir} parent
     */
    constructor(probs, path, parent) {
        parent?.dirs.push(this)
        this.probs = probs
        this.path = path
        this.parent = parent
    }

    async refresh() {
        this._files = await readdir(this.path)
        this.probs.stateManager.activeTasks.set(this)
        await this.refreshOptions()
        await this.options.setupDir?.()
        await this.populateChildren()
        this.probs.stateManager.activeTasks.delete(this)
    }

    async refreshOptions() {
        const { setupDir, teardownDir, ...parentOptions } =
            this.parent?.options || this.probs.options

        const file = this._files.find(name => name.match(/probs\.config\..?(j|t)s/))
        const options = file && (await importCfg(resolve(this.path, file)))
        this.options = { ...parentOptions, ...options }
        const picoOptions = { format: str => str.replace(/^\.\//, '') }
        this.isMatch = picomatch(this.options.glob, picoOptions)
        this.isIgnore = picomatch(this.options.ignore, picoOptions)
    }

    async populateChildren() {
        const paths = this._files.map(file =>
            [this.path, file].join('/').replace(/[\\/]+/g, '/'),
        )

        let hasChildren = false

        const promises = paths.map(async file => {
            if (!this.isIgnore(file)) {
                const stats = await stat(file)
                if (stats.isDirectory()) {
                    hasChildren = true
                    const dir = new Dir(this.probs, file, this)
                    this.dirs.push()
                    return dir.refresh()
                } else if (this.isMatch(file.replace(/^\.+\//, ''))) {
                    hasChildren = true
                    const testFile = new File(file, this)
                    // console.log('pushing test file', testFile)
                    // console.log('setup file', testFile.dir.options.setupFile.toString())
                    this.testFiles.push(testFile)
                    this.probs.onAddedFile.run({
                        scope: [file],
                        fileItem: { file, options: {} },
                    })
                    testFile.runTests()
                }
            }
        })
        return await Promise.all(promises)
    }
}

class File {
    /**
     * @param {string} path
     * @param {Dir} dir
     */
    constructor(path, dir) {
        this.path = path
        this.dir = dir

        this.dir.probs.onAddedFile.run({
            scope: [path],
            fileItem: { file: path, options: this.dir.options },
        })
    }

    async runTests() {
        const scope = [this.path]
        if (!scopeMatchesPattern(scope, this.dir.options.pattern)) {
            this.dir.probs.onClosedFile.run({ scope, ownStatus: 'skipped' })
            return
        }
        this.dir.probs.stateManager.activeTasks.set(this)
        const queueItem = await this.dir.probs.queueManager.push(() => {
            const runner = this.dir.probs.runner
            return runner(this.dir.probs, this.path, this.dir.options)
        }, this.path)
        await queueItem.resolved
        this.dir.probs.stateManager.activeTasks.delete(this)
    }
}
