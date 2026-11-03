'use strict';

const DEFAULT_HEADERS = {
  'user-agent': 'Dart/3.12 (dart:io)',
  accept: 'application/json',
  'accept-language': 'ar',
  android_version: '1.13.25',
  ios_version: '1.13.25',
  os: 'android',
};

class ApiError extends Error {
  constructor(message, { status = null, endpoint = '', retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.retryable = retryable;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(error.code);
}

function createApi(apiConfig, logger) {
  if (!apiConfig.authorization) {
    throw new Error('API_AUTHORIZATION is not set. Add it as a repository secret or local env var.');
  }
  if (!apiConfig.apiKey) {
    throw new Error('API_KEY is not set. Add it as a repository secret or local env var.');
  }

  const authorization = /^Bearer\s/i.test(apiConfig.authorization)
    ? apiConfig.authorization
    : `Bearer ${apiConfig.authorization}`;

  const headers = {
    ...DEFAULT_HEADERS,
    authorization,
    'api-key': apiConfig.apiKey,
  };

  async function post(endpoint, fields = {}) {
    const url = `${apiConfig.baseUrl}${endpoint}`;
    const maxAttempts = apiConfig.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const backoff = Math.min(30_000, 1_000 * 2 ** (attempt - 2));
        const delay = backoff + Math.floor(Math.random() * 500);
        logger.warn(`Retrying ${endpoint} in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await sleep(delay);
      }

      try {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          form.append(key, String(value));
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: form,
          signal: AbortSignal.timeout(apiConfig.timeoutMs),
        });

        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw new ApiError(`Invalid JSON response from ${endpoint}`, {
              status: response.status,
              endpoint,
              retryable: response.status === 429 || response.status >= 500,
            });
          }
        }

        if (!response.ok) {
          throw new ApiError(`HTTP ${response.status} from ${endpoint}`, {
            status: response.status,
            endpoint,
            retryable: response.status === 429 || response.status >= 500,
          });
        }

        if (!payload || payload.status === false) {
          const reason = payload && payload.message ? String(payload.message) : 'unknown error';
          throw new ApiError(`API rejected ${endpoint}: ${reason}`, {
            status: response.status,
            endpoint,
            retryable: false,
          });
        }

        return payload;
      } catch (error) {
        const retryable =
          error instanceof ApiError
            ? error.retryable
            : isRetryableNetworkError(error);
        if (!retryable || attempt === maxAttempts) {
          if (error instanceof ApiError) throw error;
          const message = error && error.message ? error.message : String(error);
          throw new ApiError(`Request to ${endpoint} failed: ${message}`, {
            endpoint,
            retryable: false,
          });
        }
      }
    }

    throw new ApiError(`Request to ${endpoint} failed after ${maxAttempts} attempts`, {
      endpoint,
    });
  }

  return {
    changeOnlineStatus(isOnline) {
      return post('/api/change_online_status', { is_online: isOnline ? 1 : 0 });
    },
    fetchTeacherDetails(teacherId) {
      return post('/api/fetch_teacher_details', { teacher_id: teacherId });
    },
    fetchCourseDetails(courseId) {
      return post('/api/fetch_course_details', { course_id: courseId });
    },
    fetchLessonSessions(lessonId, courseId) {
      return post('/api/fetch_lesson_sessions', { lesson_id: lessonId, course_id: courseId });
    },
  };
}

module.exports = { createApi, ApiError };
