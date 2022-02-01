/* ================================================================================



	notion-github-sync.
  
  Glitch example: https://glitch.com/edit/#!/notion-github-sync
  Find the official Notion API client @ https://github.com/makenotion/notion-sdk-js/

================================================================================ */

const { Client } = require("@notionhq/client")
const dotenv = require("dotenv")
const { Octokit } = require("octokit")
const _ = require("lodash")

dotenv.config()
const octokit = new Octokit({ auth: process.env.GITHUB_KEY })
const notion = new Client({ auth: process.env.NOTION_KEY })

const databaseId = process.env.NOTION_DATABASE_ID
const OPERATION_BATCH_SIZE = 10
repos = process.env.GITHUB_REPO_NAME.split(",")

/**
 * Local map to store  GitHub issue ID to its Notion pageId.
 * { [issueId: string]: string }
 */
const gitHubIssuesIdToNotionPageId = {}

/**
 * Initialize local data store.
 * Then sync with GitHub.
 */


for (const reponame of repos) {
  setInitialGitHubToNotionIdMap().then(gitHubIssuesIdToNotionPageId => {
                 syncNotionDatabaseWithGitHub(reponame, gitHubIssuesIdToNotionPageId)}) 
}

/**
 * Get and set the initial data store with issues currently in the database.
 */
async function setInitialGitHubToNotionIdMap() {
  const currentIssues = await getIssuesFromNotionDatabase()
  for await (const { pageId, issueUrl } of currentIssues) {
    gitHubIssuesIdToNotionPageId[issueUrl] = pageId
 }
 return gitHubIssuesIdToNotionPageId
}


async function syncNotionDatabaseWithGitHub(reponame, gitHubIssuesIdToNotionPageId) {
  // Get all issues currently in the provided GitHub repository.
  console.log("\nFetching issues from Notion DB...")
  const issues = await getGitHubIssuesForRepository(reponame)
  console.log(`Fetched ${issues.length} issues from ${reponame}.`)

  // Group issues into those that need to be created or updated in the Notion database.
  const { pagesToCreate, pagesToUpdate } = getNotionOperations(issues, gitHubIssuesIdToNotionPageId)

  
  // Create pages for new issues.
  console.log(`\n${pagesToCreate.length} new issues to add to Notion.`)
  await createPages(pagesToCreate)

  // Updates pages for existing issues.
  console.log(`\n${pagesToUpdate.length} issues to update in Notion.`)
  await updatePages(pagesToUpdate)

  const blocksToUpdate = await getUpdateBlocks(pagesToUpdate)
  console.log(blocksToUpdate)
  await updateBlocks(blocksToUpdate)


  // Success!
  console.log("\n✅ Notion database is synced with GitHub.")
}

/**
 * Gets pages from the Notion database.
 *
 * @returns {Promise<Array<{ pageId: string, issueNumber: number }>>}
 */
async function getIssuesFromNotionDatabase() {
  const pages = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    })
    pages.push(...results)
    if (!next_cursor) {
      break
    }
    cursor = next_cursor
  }
  console.log(`${pages.length} issues successfully fetched.`)
  return pages.map(page => {
    return {
      pageId: page.id,
      issueUrl: page.properties["Issue URL"].url,
    }
  })
}

/**
 * Gets issues from a GitHub repository. Pull requests are omitted.
 *
 * https://docs.github.com/en/rest/guides/traversing-with-pagination
 * https://docs.github.com/en/rest/reference/issues
 *
 * @returns {Promise<Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>>}
 */
async function getGitHubIssuesForRepository(reponame) {
  const issues = []
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: reponame,
    state: "all",
    per_page: 100,
  })
  for await (const { data } of iterator) {
    for (const issue of data) {
      repos = issue.repository_url.split("/")
      reponame = repos[repos.length-1]      
      if (issue.milestone != null) {
        miles = issue.milestone.title}
      else { 
        miles = null
       }
      if (!issue.pull_request) {
        issues.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          comment_count: issue.comments,
          url: issue.html_url,
	  body: issue.body,
          repository: reponame,
          status: issue.labels.name,
          milestone: miles,
          pull_request: null,
        })
      }
      else {
       issues.push({
         number: issue.number,
         title: issue.title,
         state: issue.state,
         comment_count: issue.comments,
         url: issue.html_url,
         body: issue.body,
         repository: reponame,
         status: issue.labels.name,
         milestone: miles,
         pull_request: issue.pull_request.url,
        })
       }
     }
   }
 return issues
}

/**
 * Determines which issues already exist in the Notion database.
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} issues
 * @returns {{
 *   pagesToCreate: Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>;
 *   pagesToUpdate: Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>
 * }}
 */
function getNotionOperations(issues, gitHubIssuesIdToNotionPageId) {
  const pagesToCreate = []
  const pagesToUpdate = []
 
  for (const issue of issues) {
    const pageId = gitHubIssuesIdToNotionPageId[issue.url]
    if (pageId) {
      pagesToUpdate.push({
        ...issue,
        pageId,
      })
    } else {
      pagesToCreate.push(issue)
    }
  }
  return { pagesToCreate, pagesToUpdate }
}

/**
 * Creates new pages in Notion.
 *
 * https://developers.notion.com/reference/post-page
 *
 * @param {Array<{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToCreate
 */
async function createPages(pagesToCreate) {
  const pagesToCreateChunks = _.chunk(pagesToCreate, OPERATION_BATCH_SIZE)
  for (const pagesToCreateBatch of pagesToCreateChunks) {
    await Promise.all(
      pagesToCreateBatch.map(issue =>
        notion.pages.create({
          parent: { database_id: databaseId },
          properties: getPropertiesFromIssue(issue),
          children: [getBodyFromIssue(issue)],
        })
      )
    )
    console.log(`Completed batch size: ${pagesToCreateBatch.length}`)
  }
}

/**
 * Updates provided pages in Notion.
 *
 * https://developers.notion.com/reference/patch-page
 *
 * @param {Array<{ pageId: string, number: number, title: string, state: "open" | "closed", comment_count: number, url: string }>} pagesToUpdate
 */
async function updatePages(pagesToUpdate) {
  const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE)
  for (const pagesToUpdateBatch of pagesToUpdateChunks) {
    await Promise.all(
      pagesToUpdateBatch.map(({ pageId, ...issue }) =>
        notion.pages.update({
          page_id: pageId,
          properties: getPropertiesFromIssue(issue),
        })
      )
    )
    console.log(`Completed batch size: ${pagesToUpdateBatch.length}`)
  }
}

async function getUpdateBlocks(pagesToUpdate) {
  const blocksToUpdate = []
  for (const page of pagesToUpdate) {
    const results = await notion.blocks.children.list({
      block_id: page.pageId,
      page_size: 100,
    })
    results.results.map(result => {
      block = {block_id: result.id,}
      })
    blocksToUpdate.push({
      block_id: block.block_id,
      body: page.body,
    })
  }
  return blocksToUpdate
}

async function updateBlocks(blocksToUpdate) {
  for (const block of blocksToUpdate) {
    notion.blocks.update({
      block_id: block.block_id,
      paragraph: {
        text:[{
          type: 'text',
          text: {
            content: block.body,
            link: null,
            }
          }]
      }
   })
}
}





//*========================================================================
// Helpers
//*========================================================================

/**
 * Returns the GitHub issue to conform to this database's schema properties.
 *
 * @param {{ number: number, title: string, state: "open" | "closed", comment_count: number, url: string }} issue
 */
function getPropertiesFromIssue(issue) {
  const { title, number, state, comment_count, url, body, repository } = issue
  return {
    Name: {
      title: [{ type: "text", text: { content: title } }],
    },
    "Issue Number": {
      number,
    },
    State: {
      select: { name: state },
    },
    "Number of Comments": {
      number: comment_count,
    },
    "Issue URL": {
      url,
    },
   "Repository": {
     select: {name: repository},
    }
   }
 }

function getBodyFromIssue(issue) {
  const { body } = issue
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      text: [
        {
          type: 'text',
          text: {
            content: body,
	    link: null,
             },
        },
      ],
     },
}
}
