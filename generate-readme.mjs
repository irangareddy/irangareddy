#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const TEMPLATE_PATH = path.join(ROOT, 'TEMPLATE.md')
const README_PATH = path.join(ROOT, 'README.md')

const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  Swift: '#F05138',
  Dart: '#00B4AB',
  HTML: '#e34c26',
  CSS: '#563d7c',
  'Jupyter Notebook': '#DA5B0B',
  C: '#555555',
  'C++': '#f34b7d',
  Go: '#00ADD8',
  Kotlin: '#A97BFF',
  Rust: '#dea584',
  Shell: '#89e051',
  Vue: '#41b883',
  Default: '#555555',
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    return null
  }
  return value.trim()
}

function getToken() {
  const envToken = requireEnv('USER_TOKEN') || requireEnv('USER_API_TOKEN') || requireEnv('GITHUB_TOKEN')
  if (envToken) {
    return envToken
  }

  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('No GitHub token found. Set USER_TOKEN, USER_API_TOKEN, or GITHUB_TOKEN.')
  }
}

async function graphql(token, query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'irangareddy-profile-readme',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }

  const payload = await response.json()
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '))
  }

  return payload.data
}

async function fetchProfile(token, fromDate) {
  const query = `
    query Profile($fromDate: DateTime!) {
      viewer {
        login
        name
        bio
        createdAt
        followers {
          totalCount
        }
        pinnedItems(first: 6, types: REPOSITORY) {
          nodes {
            ... on Repository {
              name
              description
              url
              stargazerCount
              isFork
              primaryLanguage {
                name
                color
              }
            }
          }
        }
        contributionsCollection(from: $fromDate) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
        }
      }
    }
  `

  return graphql(token, query, { fromDate })
}

async function fetchAllPublicRepos(token) {
  const repos = []
  let cursor = null

  while (true) {
    const query = `
      query PublicRepos($cursor: String) {
        viewer {
          repositories(
            first: 100
            after: $cursor
            ownerAffiliations: OWNER
            privacy: PUBLIC
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
              description
              url
              isFork
              pushedAt
              stargazerCount
              primaryLanguage {
                name
                color
              }
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges {
                  size
                  node {
                    name
                    color
                  }
                }
              }
            }
          }
        }
      }
    `

    const data = await graphql(token, query, { cursor })
    const connection = data.viewer.repositories
    repos.push(...connection.nodes)

    if (!connection.pageInfo.hasNextPage) {
      return {
        totalCount: connection.totalCount,
        repos,
      }
    }

    cursor = connection.pageInfo.endCursor
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

function yearsSince(isoDate) {
  const start = new Date(isoDate)
  const now = new Date()
  return Math.max(1, Math.floor((now - start) / (365.25 * 24 * 60 * 60 * 1000)))
}

function languageBadge(name, color, percentage) {
  const safeColor = encodeURIComponent((color || LANGUAGE_COLORS[name] || LANGUAGE_COLORS.Default).replace('#', '#'))
  const message = encodeURIComponent(`${name} ${percentage}%`)
  return `![${name}](https://img.shields.io/static/v1?style=flat-square&label=%E2%A0%80&color=555&labelColor=${safeColor}&message=${message})`
}

function topLanguages(repos, fromDate) {
  const fromTime = new Date(fromDate).getTime()
  const counts = new Map()

  for (const repo of repos) {
    if (repo.isFork) {
      continue
    }

    if (new Date(repo.pushedAt).getTime() < fromTime) {
      continue
    }

    const primaryLanguage = repo.primaryLanguage?.name
    if (!primaryLanguage) {
      continue
    }

    const current = counts.get(primaryLanguage) || {
      count: 0,
      color: repo.primaryLanguage.color || LANGUAGE_COLORS[primaryLanguage] || LANGUAGE_COLORS.Default,
    }
    current.count += 1
    counts.set(primaryLanguage, current)
  }

  const total = [...counts.values()].reduce((sum, entry) => sum + entry.count, 0)
  if (!total) {
    return []
  }

  return [...counts.entries()]
    .map(([name, entry]) => ({
      name,
      color: entry.color,
      percentage: Math.max(0.1, Math.round((entry.count / total) * 1000) / 10),
    }))
    .sort((a, b) => b.percentage - a.percentage)
    .slice(0, 5)
}

function pickFeaturedRepos(profile, repos) {
  const repoMap = new Map(repos.map((repo) => [repo.name, repo]))
  const pinned = profile.viewer.pinnedItems.nodes
    .filter(Boolean)
    .filter((repo) => !repo.isFork)
    .map((repo) => repoMap.get(repo.name) || repo)

  if (pinned.length) {
    return pinned.slice(0, 6)
  }

  return [...repos]
    .sort((a, b) => b.stargazerCount - a.stargazerCount)
    .slice(0, 6)
}

function renderFeaturedProjects(repos) {
  return repos
    .map((repo) => {
      const language = repo.primaryLanguage?.name ? ` · ${repo.primaryLanguage.name}` : ''
      const stars = repo.stargazerCount ? ` · ${formatNumber(repo.stargazerCount)} stars` : ''
      const description = repo.description || 'Public project from my GitHub profile.'
      return `- [${repo.name}](${repo.url})${language}${stars}\n  ${description}`
    })
    .join('\n')
}

function renderSnapshotRows(profile, publicRepoSummary, languages, fromDate) {
  const recent = profile.viewer.contributionsCollection
  const age = yearsSince(profile.viewer.createdAt)
  const publicProjectStars = publicRepoSummary.repos
    .filter((repo) => !repo.isFork)
    .reduce((sum, repo) => sum + repo.stargazerCount, 0)

  const publicItems = [
    `📦 **${formatNumber(publicRepoSummary.totalCount)}** public repos`,
    `⭐ **${formatNumber(publicProjectStars)}** stars on public projects`,
    `👥 **${formatNumber(profile.viewer.followers.totalCount)}** followers`,
    `🕰️ **${formatNumber(age)}** years on GitHub`,
  ]

  const trackedContributions =
    recent.totalCommitContributions +
    recent.totalPullRequestContributions +
    recent.totalIssueContributions +
    recent.totalPullRequestReviewContributions

  const recentItems = [
    `🔥 **${formatNumber(recent.totalCommitContributions)}** commits`,
    `🔀 **${formatNumber(recent.totalPullRequestContributions)}** pull requests`,
    `📝 **${formatNumber(recent.totalIssueContributions)}** issues`,
    `⚡ **${formatNumber(trackedContributions)}** tracked contributions`,
  ]

  const languageItems = languages.length
    ? languages.map((language) => languageBadge(language.name, language.color, language.percentage))
    : ['Public repos were not active enough in the last 12 months to rank languages.']

  const maxRows = Math.max(publicItems.length, recentItems.length, languageItems.length)
  const rows = []

  for (let index = 0; index < maxRows; index += 1) {
    rows.push(`| ${publicItems[index] || ''} | ${recentItems[index] || ''} | ${languageItems[index] || ''} |`)
  }

  return rows.join('\n')
}

async function main() {
  const token = getToken()
  const today = new Date()
  const oneYearAgo = new Date(today)
  oneYearAgo.setFullYear(today.getFullYear() - 1)

  const fromDate = oneYearAgo.toISOString()
  const [profile, publicRepoSummary, template] = await Promise.all([
    fetchProfile(token, fromDate),
    fetchAllPublicRepos(token),
    fs.readFile(TEMPLATE_PATH, 'utf8'),
  ])

  const name = profile.viewer.name || profile.viewer.login
  const bio = profile.viewer.bio || 'Building products with code.'
  const languages = topLanguages(publicRepoSummary.repos, fromDate)
  const featuredRepos = pickFeaturedRepos(profile, publicRepoSummary.repos)

  const readme = template
    .replaceAll('{{ NAME }}', name)
    .replaceAll('{{ BIO }}', bio)
    .replaceAll('{{ SNAPSHOT_ROWS }}', renderSnapshotRows(profile, publicRepoSummary, languages, fromDate))
    .replaceAll('{{ FEATURED_PROJECTS }}', renderFeaturedProjects(featuredRepos))

  await fs.writeFile(README_PATH, `${readme.trim()}\n`)
  console.log(`README generated at ${README_PATH}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
