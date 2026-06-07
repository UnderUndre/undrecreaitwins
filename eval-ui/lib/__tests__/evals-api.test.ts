import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getEvalRuns, getEvalRun } from '../evals-api'

describe('evals-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('should fetch eval runs with correct headers', async () => {
    const mockRuns = {
      total: 1,
      data: [
        {
          id: 'run-1',
          started_at: '2026-06-07T10:00:00Z',
          finished_at: '2026-06-07T10:05:00Z',
          passed_cases: 5,
          total_cases: 5,
        },
      ],
    }

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockRuns,
    })

    const result = await getEvalRuns()

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/evals/runs'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Bearer'),
          'X-Tenant-ID': expect.any(String),
        }),
      })
    )
    expect(result).toEqual(mockRuns)
  })

  it('should throw error on API failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    })

    await expect(getEvalRuns()).rejects.toThrow('API error: 401')
  })

  it('should fetch single eval run', async () => {
    const mockRun = {
      id: 'run-1',
      started_at: '2026-06-07T10:00:00Z',
      finished_at: '2026-06-07T10:05:00Z',
      passed_cases: 5,
      total_cases: 5,
    }

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockRun,
    })

    const result = await getEvalRun('run-1')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/evals/runs/run-1'),
      expect.any(Object)
    )
    expect(result).toEqual(mockRun)
  })
})
