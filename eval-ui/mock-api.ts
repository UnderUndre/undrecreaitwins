const http = require('http')

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST')

  if (req.url === '/v1/evals/runs') {
    res.writeHead(200)
    res.end(JSON.stringify({
      total: 2,
      data: [
        {
          id: 'run-001',
          started_at: '2026-06-07T08:00:00Z',
          finished_at: '2026-06-07T08:05:00Z',
          passed_cases: 5,
          total_cases: 5,
        },
        {
          id: 'run-002',
          started_at: '2026-06-07T07:30:00Z',
          finished_at: null,
          passed_cases: 3,
          total_cases: 5,
        },
      ],
    }))
    return
  }

  if (req.url && req.url.startsWith('/v1/evals/runs/')) {
    const id = req.url.split('/').pop()
    res.writeHead(200)
    res.end(JSON.stringify({
      id,
      started_at: '2026-06-07T08:00:00Z',
      finished_at: '2026-06-07T08:05:00Z',
      passed_cases: 5,
      total_cases: 5,
    }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(8090, () => {
  console.log('Mock eval API running on http://localhost:8090')
})
