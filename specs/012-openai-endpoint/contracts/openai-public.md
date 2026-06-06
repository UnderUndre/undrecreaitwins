# Public OpenAI Endpoint Contract

## Base URL
https://api.aitwins.ai (Public)

## Authentication
Authorization: Bearer sk-aitw_...

## Endpoints

### 1. List Models
GET /v1/models
Returns OpenAI-compatible model list of workspace assistants.

### 2. Chat Completions
POST /v1/chat/completions
Standard OpenAI request body. model field must be asst_<slug>.
