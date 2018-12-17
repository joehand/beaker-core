const emitStream = require('emit-stream')
const {URL} = require('url')
const _throttle = require('lodash.throttle')
const lock = require('../lib/lock')
const db = require('../dbs/profile-data-db')
const archivesDb = require('../dbs/archives')
const users = require('../users')
const dat = require('../dat')

const {crawlerEvents} = require('./util')
const posts = require('./posts')
const followgraph = require('./followgraph')
const siteDescriptions = require('./site-descriptions')

const CRAWL_POLL_INTERVAL = 30e3

// globals
// =

const watches = {}

// exported api
// =

exports.posts = posts
exports.followgraph = followgraph
exports.siteDescriptions = siteDescriptions
const createEventsStream = exports.createEventsStream = () => emitStream(crawlerEvents)

exports.setup = async function () {
}

exports.watchSite = async function (archive) {
  if (typeof archive === 'string') {
    archive = await dat.library.getOrLoadArchive(archive)
  }
  console.log('watchSite', archive.url)

  if (!(archive.url in watches)) {
    crawlerEvents.emit('watch', {sourceUrl: archive.url})
    const queueCrawl = _throttle(() => crawlSite(archive), 5e3)

    // watch for file changes
    watches[archive.url] = archive.pda.watch()
    watches[archive.url].on('data', ([event, args]) => {
      console.log('MIRACLE ALERT! The crawler watch stream emitted a change event', archive.url, event, args)
      if (event === 'invalidated') {
        queueCrawl()
      }
    })

    // HACK
    // for reasons that currently surpass me
    // the `archive.pda.watch()` call is not currently working all the time
    // so we need to poll sites for now
    setInterval(queueCrawl, CRAWL_POLL_INTERVAL)

    // run the first crawl
    crawlSite(archive)
  }
}

exports.unwatchSite = async function (url) {
  // stop watching for file changes
  if (url in watches) {
    crawlerEvents.emit('unwatch', {sourceUrl: url})
    watches[url].close()
    watches[url] = null
  }
}

const crawlSite =
exports.crawlSite = async function (archive) {
  console.log('crawling', archive.url)
  crawlerEvents.emit('crawl-start', {sourceUrl: archive.url})
  var release = await lock('crawl:' + archive.url)
  try {
    // get/create crawl source
    var crawlSource = await db.get(`SELECT id, url FROM crawl_sources WHERE url = ?`, [archive.url])
    if (!crawlSource) {
      let res = await db.run(`INSERT INTO crawl_sources (url) VALUES (?)`, [archive.url])
      crawlSource = {id: res.lastID, url: archive.url}
    }

    // crawl individual sources
    await Promise.all([
      posts.crawlSite(archive, crawlSource),
      followgraph.crawlSite(archive, crawlSource),
      siteDescriptions.crawlSite(archive, crawlSource)
    ])
  } catch (err) {
    crawlerEvents.emit('crawl-error', {sourceUrl: archive.url, err: err.toString()})
  } finally {
    crawlerEvents.emit('crawl-finish', {sourceUrl: archive.url})
    release()
  }
}

const getCrawlStates =
exports.getCrawlStates = async function () {
  var rows = await db.all(`
    SELECT
        crawl_sources.url AS url,
        GROUP_CONCAT(crawl_sources_meta.crawlSourceVersion) AS versions,
        GROUP_CONCAT(crawl_sources_meta.crawlDataset) AS datasets,
        MAX(crawl_sources_meta.updatedAt) AS updatedAt
      FROM crawl_sources
      INNER JOIN crawl_sources_meta ON crawl_sources_meta.crawlSourceId = crawl_sources.id
      GROUP BY crawl_sources.id
  `)
  return Promise.all(rows.map(async ({url, versions, datasets, updatedAt}) => {
    var datasetVersions = {}
    versions = versions.split(',')
    datasets = datasets.split(',')
    for (let i = 0; i < datasets.length; i++) {
      datasetVersions[datasets[i]] = Number(versions[i])
    }
    var meta = await archivesDb.getMeta(toHostname(url))
    return {url, title: meta.title, datasetVersions, updatedAt}
  }))
}

const resetSite =
exports.resetSite = async function (url) {
  await db.run(`DELETE FROM crawl_sources WHERE url = ?`, [url])
}

exports.WEBAPI = {createEventsStream, getCrawlStates, resetSite}

// internal methods
// =

function toHostname (url) {
  url = new URL(url)
  return url.hostname
}
