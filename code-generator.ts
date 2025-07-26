import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

// DeepSeek API Configuration - Using NON-REASONING model as per professor's requirements
const DEEPSEEK_API_KEY = "sk-43c52ba16c3f4308890bc63e21cae08a";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// Multi-Agent System for Reasoning (as per professor's guidance)
const AGENT_ROLES = {
  ANALYZER: 'analyzer',    // Analyzes the problem
  PLANNER: 'planner',      // Creates solution strategy  
  CODER: 'coder',          // Implements the code
  REVIEWER: 'reviewer'     // Reviews and improves code
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { 
      problem_id, 
      language = 'python', 
      stream = true, 
      include_reasoning = true, 
      context = '', 
      attempt_number = 1,
      use_multi_agent = true,  // NEW: Enable multi-agent reasoning
      auto_mode = false        // NEW: Auto-test and improve mode
    } = await req.json()

    if (!problem_id) {
      return new Response(
        JSON.stringify({ error: 'Missing problem_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Fetch problem from database  
    const { data: problem, error: dbError } = await supabase
      .from('problems')
      .select('*')
      .eq('id', problem_id)
      .single()

    if (dbError || !problem) {
      return new Response(
        JSON.stringify({ error: 'Problem not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Use multi-agent reasoning system instead of reasoning model
    if (auto_mode && stream) {
      return createAutoModeStreamingResponse(problem, language, include_reasoning, context, attempt_number)
    } else if (use_multi_agent && stream) {
      return createMultiAgentStreamingResponse(problem, language, include_reasoning, context, attempt_number)
    } else if (stream) {
      return createStreamingResponse(problem, language, include_reasoning, context, attempt_number)
    } else {
      return createNonStreamingResponse(problem, language, context, attempt_number)
    }

  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function createStreamingResponse(problem, language, includeReasoning, context, attemptNumber) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start (controller) {
      let streamClosed = false // ⭐ Track stream state
      ;
      // Helper function to safely enqueue data
      const safeEnqueue = (data)=>{
        if (!streamClosed) {
          try {
            controller.enqueue(encoder.encode(data));
          } catch (error) {
            console.error('Failed to enqueue data:', error);
            streamClosed = true;
          }
        }
      };
      // Helper function to safely close stream
      const safeClose = ()=>{
        if (!streamClosed) {
          try {
            streamClosed = true;
            controller.close();
          } catch (error) {
            console.error('Failed to close stream:', error);
          }
        }
      };
      try {
        const prompt = buildPrompt(problem, language, context, attemptNumber);
        // Call DeepSeek API with streaming
        const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: getSystemPrompt(language)
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            stream: true,
            max_tokens: 32000
          })
        });
        if (!response.ok) {
          throw new Error(`DeepSeek API error: ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let reasoningComplete = false;
        while(!streamClosed){
          const { done, value } = await reader.read();
          if (done) {
            // Send final completion and close
            const completeChunk = {
              type: 'complete',
              metadata: {
                timestamp: new Date().toISOString(),
                language,
                problem_id: problem.id
              }
            };
            safeEnqueue(`data: ${JSON.stringify(completeChunk)}\n\n`);
            safeClose();
            break;
          }
          buffer += decoder.decode(value, {
            stream: true
          });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines){
            if (streamClosed) break; // ⭐ Exit if stream closed
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                // Send completion metadata and close
                const completeChunk = {
                  type: 'complete',
                  metadata: {
                    timestamp: new Date().toISOString(),
                    language,
                    problem_id: problem.id
                  }
                };
                safeEnqueue(`data: ${JSON.stringify(completeChunk)}\n\n`);
                safeClose();
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                if (delta && !streamClosed) {
                  // Handle reasoning content
                  if (delta.reasoning_content && includeReasoning && !reasoningComplete) {
                    const reasoningChunk = {
                      type: 'reasoning',
                      content: delta.reasoning_content
                    };
                    safeEnqueue(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
                  }
                  // Handle code content
                  if (delta.content) {
                    if (!reasoningComplete) {
                      reasoningComplete = true;
                      // Send a separator
                      const separatorChunk = {
                        type: 'reasoning',
                        content: '\n\n--- Solution ---\n\n'
                      };
                      safeEnqueue(`data: ${JSON.stringify(separatorChunk)}\n\n`);
                    }
                    // Extract and send only code content
                    const codeContent = extractCodeFromStreamContent(delta.content);
                    if (codeContent) {
                      const codeChunk = {
                        type: 'code',
                        content: codeContent
                      };
                      safeEnqueue(`data: ${JSON.stringify(codeChunk)}\n\n`);
                    }
                  }
                }
              } catch (parseError) {
                console.error('Error parsing streaming response:', parseError);
              // Don't break the stream on parse errors, just continue
              }
            }
          }
        }
      } catch (error) {
        console.error('Streaming error:', error);
        if (!streamClosed) {
          const errorChunk = {
            type: 'error',
            content: error.message
          };
          safeEnqueue(`data: ${JSON.stringify(errorChunk)}\n\n`);
          safeClose();
        }
      }
    }
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
async function createNonStreamingResponse(problem, language, context, attemptNumber) {
  const prompt = buildPrompt(problem, language, context, attemptNumber);
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: getSystemPrompt(language)
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false,
      max_tokens: 32000
    })
  });
  const data = await response.json();
  return new Response(JSON.stringify({
    generated_code: data.choices[0].message.content,
    reasoning_content: data.choices[0].message.reasoning_content,
    model_used: 'deepseek-reasoner',
    generation_time: Date.now(),
    problem_id: problem.id,
    language
  }), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function getSystemPrompt(language) {
  // SIMPLIFIED PROMPT FOR SPEED
  return `You are a coding assistant. Generate ONLY executable code with no explanations.

CRITICAL: Your response must contain ONLY the complete Python class code, nothing else.
No markdown, no explanations, no comments except brief inline ones.

Example format:
from typing import List

class Solution:
    def methodName(self, params) -> ReturnType:
        # brief comment
        return result`;
}
function buildPrompt(problem, language, context, attemptNumber) {
  // Convert HTML to readable text (simplified)
  const problemText = problem.content_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // Parse test cases for examples
  const examples = parseExamplesFromTestCases(problem.test_cases);
  let prompt = `
Problem: ${problem.title}
Difficulty: ${problem.difficulty}

Description:
${problemText}

Examples:
${examples}

Starting Code Template:
\`\`\`${language}
${problem.code}
\`\`\`
`;
  // Add context from previous attempts if this is not the first attempt
  if (context && attemptNumber > 1) {
    prompt += `\n${context}\n`;
  } else {
    prompt += `\nPlease provide a complete, efficient solution that passes all test cases.\n`;
  }
  return prompt;
}
function extractExplanationFromResponse(content) {
  // Extract everything except the code block
  let explanation = content;
  // Remove the code block
  explanation = explanation.replace(/```python\n[\s\S]*?\n```/g, '');
  // Remove the class definition if it appears outside code blocks
  explanation = explanation.replace(/(^|\n)class Solution:[\s\S]*?(?=\n\n|\n#|$)/g, '');
  // Clean up extra whitespace and formatting
  explanation = explanation.replace(/\n\s*\n\s*\n/g, '\n\n') // Multiple newlines to double
  .replace(/### Solution Code[\s\S]*?(?=###|$)/g, '') // Remove "Solution Code" sections
  .trim();
  return explanation || 'No explanation provided';
}
function extractCodeFromResponse(content) {
  console.log('=== EXTRACTION FUNCTION CALLED ===');
  console.log('Input content type:', typeof content);
  console.log('Input content length:', content?.length || 'undefined');
  if (!content) {
    console.log('ERROR: No content provided to extraction function');
    return 'ERROR: No content';
  }
  console.log('Content preview:', content.substring(0, 100) + '...');
  // SIMPLE TEST: Just try to find and extract the code block
  const pythonIndex = content.indexOf('```python');
  console.log('```python found at index:', pythonIndex);
  if (pythonIndex >= 0) {
    const codeStart = pythonIndex + 9;
    const nextBackticks = content.indexOf('```', codeStart);
    console.log('Closing ``` found at index:', nextBackticks);
    if (nextBackticks > 0) {
      const code = content.substring(codeStart, nextBackticks).trim();
      console.log('=== EXTRACTED CODE SUCCESS ===');
      console.log(code);
      console.log('=== END EXTRACTED ===');
      return code;
    }
  }
  console.log('=== EXTRACTION FAILED - RETURNING ORIGINAL ===');
  return content;
}
function extractWithoutCodeBlock(content) {
  console.log('Using fallback extraction method');
  // Find all lines
  const lines = content.split('\n');
  const codeLines: string[] = [];
  let capturing = false;
  for(let i = 0; i < lines.length; i++){
    const line = lines[i];
    // Start capturing at class Solution or from typing
    if (line.includes('class Solution:') || line.includes('from typing import List')) {
      capturing = true;
      codeLines.push(line);
      console.log('Started capturing at line:', i, line);
      continue;
    }
    // If we're capturing, continue until we hit explanation text
    if (capturing) {
      // Stop at explanation sections
      if (line.trim().startsWith('###') || line.trim().startsWith('Explanation') || line.trim().startsWith('1.') || line.trim().startsWith('This approach') || line.trim().startsWith('**')) {
        console.log('Stopped capturing at line:', i, line.trim());
        break;
      }
      codeLines.push(line);
    }
  }
  const result = codeLines.join('\n').trim();
  console.log('=== FALLBACK EXTRACTED CODE ===');
  console.log(result);
  console.log('=== END FALLBACK CODE ===');
  return result || content // If nothing extracted, return original
  ;
}
function extractCodeFromStreamContent(content) {
  // For streaming, we want to pass through code content but filter out explanatory text
  // Simple heuristic: if it looks like code (starts with spaces, contains Python keywords), keep it
  const trimmed = content.trim();
  // Skip obvious explanatory text
  if (trimmed.startsWith('###') || trimmed.startsWith('Explanation') || trimmed.startsWith('This ') || trimmed.startsWith('The ') || trimmed.startsWith('We ') || trimmed.includes('approach') || trimmed.includes('solution')) {
    return '';
  }
  // Keep code-like content
  if (content.includes('class ') || content.includes('def ') || content.includes('return ') || content.includes('    ') || content.includes('from ') || content.includes('import ')) {
    return content;
  }
  // For streaming, be more permissive to avoid cutting off code
  return content;
}
function parseExamplesFromTestCases(testCases) {
  try {
    // Parse test cases and format as examples
    const cases = testCases.split('), (');
    const examples = cases.slice(0, 2).map((caseStr, index)=>{
      const cleaned = caseStr.replace(/^\(/, '').replace(/\)$/, '');
      const parts = cleaned.split(', ');
      if (parts.length >= 2) {
        const inputs = parts.slice(0, -1);
        const output = parts[parts.length - 1];
        return `Example ${index + 1}:
Input: ${inputs.join(', ')}
Output: ${output}`;
      }
      return '';
    }).filter(Boolean);
    return examples.join('\n\n');
  } catch (error) {
    return 'Examples will be provided in test cases.';
  }
}

// NEW: Multi-Agent Reasoning System (Professor's Recommendation)
function createMultiAgentStreamingResponse(problem, language, includeReasoning, context, attemptNumber) {
  const encoder = new TextEncoder()
  
  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false

      const safeEnqueue = (data) => {
        if (!streamClosed) {
          try {
            controller.enqueue(encoder.encode(data))
          } catch (error) {
            console.error('Failed to enqueue data:', error)
            streamClosed = true
          }
        }
      }

      const safeClose = () => {
        if (!streamClosed) {
          try {
            streamClosed = true
            controller.close()
          } catch (error) {
            console.error('Failed to close stream:', error)
          }
        }
      }

      try {
        // MULTI-AGENT REASONING PROCESS
        
        // Agent 1: ANALYZER - Analyze the problem
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '🔍 **ANALYZER AGENT**: Analyzing problem structure...\n\n'
        })}\n\n`)
        
        const analysisResult = await runAgent(AGENT_ROLES.ANALYZER, problem, language, context, attemptNumber)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning', 
          content: analysisResult + '\n\n'
        })}\n\n`)

        // Agent 2: PLANNER - Create solution strategy
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '📋 **PLANNER AGENT**: Developing solution strategy...\n\n'
        })}\n\n`)
        
        const planResult = await runAgent(AGENT_ROLES.PLANNER, problem, language, context, attemptNumber, analysisResult)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: planResult + '\n\n'
        })}\n\n`)

        // Agent 3: CODER - Implement the solution
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '💻 **CODER AGENT**: Implementing solution...\n\n'
        })}\n\n`)
        
        const codeResult = await runAgent(AGENT_ROLES.CODER, problem, language, context, attemptNumber, analysisResult + '\n' + planResult)
        
        // Extract and stream the code
        const extractedCode = extractCodeFromResponse(codeResult)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'code',
          content: extractedCode
        })}\n\n`)

        // Agent 4: REVIEWER - Review and suggest improvements  
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '\n\n🔍 **REVIEWER AGENT**: Reviewing solution...\n\n'
        })}\n\n`)
        
        const reviewResult = await runAgent(AGENT_ROLES.REVIEWER, problem, language, context, attemptNumber, extractedCode)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: reviewResult + '\n\n'
        })}\n\n`)

        // Send completion
        safeEnqueue(`data: ${JSON.stringify({
          type: 'complete',
          metadata: {
            timestamp: new Date().toISOString(),
            language,
            problem_id: problem.id,
            reasoning_method: 'multi_agent'
          }
        })}\n\n`)
        
        safeClose()

      } catch (error) {
        console.error('Multi-agent streaming error:', error)
        if (!streamClosed) {
          const errorChunk = {
            type: 'error',
            content: error.message
          }
          safeEnqueue(`data: ${JSON.stringify(errorChunk)}\n\n`)
          safeClose()
        }
      }
    }
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 
      'Connection': 'keep-alive'
    }
  })
}

// NEW: Auto-mode streaming response (generate + test + improve automatically)
function createAutoModeStreamingResponse(problem, language, includeReasoning, context, attemptNumber) {
  const encoder = new TextEncoder()
  
  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false

      const safeEnqueue = (data) => {
        if (!streamClosed) {
          try {
            controller.enqueue(encoder.encode(data))
          } catch (error) {
            console.error('Failed to enqueue data:', error)
            streamClosed = true
          }
        }
      }

      const safeClose = () => {
        if (!streamClosed) {
          try {
            streamClosed = true
            controller.close()
          } catch (error) {
            console.error('Failed to close stream:', error)
          }
        }
      }

      try {
        // Step 1: Generate initial solution using multi-agent system
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '🤖 **AUTO MODE**: Generating solution with multi-agent reasoning...\n\n'
        })}\n\n`)

        const initialSolution = await runMultiAgentGeneration(problem, language, context, attemptNumber)
        
        // Stream the generated code
        safeEnqueue(`data: ${JSON.stringify({
          type: 'code',
          content: initialSolution.code
        })}\n\n`)
        
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: initialSolution.reasoning + '\n\n'
        })}\n\n`)

        // Step 2: Auto-test the solution
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '🧪 **AUTO-TESTING**: Running test cases...\n\n'
        })}\n\n`)

        const testResult = await autoTestSolution(problem.id, initialSolution.code, language)
        
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: `📊 **TEST RESULTS**: ${testResult.passed_tests}/${testResult.total_tests} tests passed (${testResult.success_rate}%)\n\n`
        })}\n\n`)

        // Step 3: If tests pass, we're done
        if (testResult.success_rate === 100) {
          safeEnqueue(`data: ${JSON.stringify({
            type: 'reasoning',
            content: '🎉 **SUCCESS**: All tests passed! Solution is ready.\n\n'
          })}\n\n`)
          
          safeEnqueue(`data: ${JSON.stringify({
            type: 'complete',
            metadata: {
              timestamp: new Date().toISOString(),
              language,
              problem_id: problem.id,
              success_rate: 100,
              attempts: 1,
              mode: 'auto'
            }
          })}\n\n`)
          
          safeClose()
          return
        }

        // Step 4: Auto-improve if tests failed (max 3 attempts)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'reasoning',
          content: '🔄 **AUTO-IMPROVE**: Tests failed. Starting improvement process (max 3 attempts)...\n\n'
        })}\n\n`)

        const improvementResult = await autoImprove(problem.id, testResult, language, 3)
        
        // Stream improvement process
        for (const update of improvementResult.updates) {
          safeEnqueue(`data: ${JSON.stringify({
            type: 'reasoning',
            content: update
          })}\n\n`)
        }

        // Stream final improved code if available
        if (improvementResult.final_solution) {
          safeEnqueue(`data: ${JSON.stringify({
            type: 'code',
            content: improvementResult.final_solution.code
          })}\n\n`)
        }

        // Send completion
        safeEnqueue(`data: ${JSON.stringify({
          type: 'complete',
          metadata: {
            timestamp: new Date().toISOString(),
            language,
            problem_id: problem.id,
            success_rate: improvementResult.final_success_rate,
            attempts: improvementResult.total_attempts,
            mode: 'auto'
          }
        })}\n\n`)
        
        safeClose()

      } catch (error) {
        console.error('Auto-mode streaming error:', error)
        if (!streamClosed) {
          const errorChunk = {
            type: 'error',
            content: `Auto-mode failed: ${error.message}`
          }
          safeEnqueue(`data: ${JSON.stringify(errorChunk)}\n\n`)
          safeClose()
        }
      }
    }
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 
      'Connection': 'keep-alive'
    }
  })
}

// Helper function to run multi-agent generation and return structured result
async function runMultiAgentGeneration(problem, language, context, attemptNumber) {
  let reasoning = ''
  let code = ''
  
  // Run all agents
  const analysisResult = await runAgent(AGENT_ROLES.ANALYZER, problem, language, context, attemptNumber)
  reasoning += `🔍 **ANALYZER**: ${analysisResult}\n\n`
  
  const planResult = await runAgent(AGENT_ROLES.PLANNER, problem, language, context, attemptNumber, analysisResult)
  reasoning += `📋 **PLANNER**: ${planResult}\n\n`
  
  const codeResult = await runAgent(AGENT_ROLES.CODER, problem, language, context, attemptNumber, analysisResult + '\n' + planResult)
  code = extractCodeFromResponse(codeResult)
  
  const reviewResult = await runAgent(AGENT_ROLES.REVIEWER, problem, language, context, attemptNumber, code)
  reasoning += `🔍 **REVIEWER**: ${reviewResult}\n\n`
  
  return { code, reasoning }
}

// Helper function to test solution automatically
async function autoTestSolution(problemId, solutionCode, language) {
  const response = await fetch('https://mbuiluhrtlgyawlqchaq.supabase.co/functions/v1/smart-handler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem_id: problemId,
      solution_code: solutionCode,
      language
    })
  })

  if (!response.ok) {
    throw new Error(`Testing failed: ${response.status}`)
  }

  return await response.json()
}

// Helper function to auto-improve solution
async function autoImprove(problemId, testResult, language, maxAttempts) {
  const response = await fetch('https://mbuiluhrtlgyawlqchaq.supabase.co/functions/v1/reinforcement-loop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem_id: problemId,
      language,
      max_attempts: maxAttempts,
      initial_test_result: testResult
    })
  })

  if (!response.ok) {
    throw new Error(`Improvement failed: ${response.status}`)
  }

  return await response.json()
}

// Run individual agent with specific role
async function runAgent(role, problem, language, context, attemptNumber, previousAgentOutput = '') {
  const prompt = buildAgentPrompt(role, problem, language, context, attemptNumber, previousAgentOutput)
  
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat', // NON-REASONING model as per professor's requirement
      messages: [
        {
          role: 'system',
          content: getAgentSystemPrompt(role, language)
        },
        {
          role: 'user', 
          content: prompt
        }
      ],
      stream: false,
      max_tokens: 8000,
      temperature: role === AGENT_ROLES.CODER ? 0.1 : 0.3 // Lower temp for code, higher for reasoning
    })
  })

  if (!response.ok) {
    throw new Error(`Agent ${role} failed: ${response.status}`)
  }

  const data = await response.json()
  return data.choices[0].message.content
}

// Build agent-specific prompts
function buildAgentPrompt(role, problem, language, context, attemptNumber, previousOutput) {
  const baseInfo = `
Problem: ${problem.title}
Difficulty: ${problem.difficulty}
Language: ${language}
Attempt: ${attemptNumber}

Description: ${problem.content_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}

${context ? `Previous Attempt Context:\n${context}\n` : ''}
${previousOutput ? `Previous Agent Output:\n${previousOutput}\n` : ''}
`

  switch (role) {
    case AGENT_ROLES.ANALYZER:
      return `${baseInfo}

As the ANALYZER agent, your job is to:
1. Identify the core problem type (array, string, graph, etc.)
2. Determine key constraints and edge cases
3. Identify optimal time/space complexity targets
4. Highlight potential pitfalls

Provide a structured analysis in 2-3 paragraphs.`

    case AGENT_ROLES.PLANNER:
      return `${baseInfo}

As the PLANNER agent, your job is to:
1. Choose the best algorithmic approach based on the analysis
2. Break down the solution into clear steps
3. Plan the data structures needed
4. Consider alternative approaches

Provide a step-by-step solution plan.`

    case AGENT_ROLES.CODER:
      return `${baseInfo}

As the CODER agent, your job is to:
1. Implement the planned solution in clean, efficient code
2. Handle all edge cases identified
3. Follow the provided code template structure
4. Ensure optimal complexity

Generate ONLY the complete Python class code, properly formatted.`

    case AGENT_ROLES.REVIEWER:
      return `${baseInfo}

As the REVIEWER agent, your job is to:
1. Check the code for correctness and efficiency
2. Identify potential bugs or edge case issues
3. Suggest optimizations if any
4. Verify it matches the problem requirements

Provide a brief review with any concerns or confirmations.`

    default:
      return baseInfo
  }
}

// Agent-specific system prompts
function getAgentSystemPrompt(role, language) {
  const basePrompt = `You are a specialized AI agent in a multi-agent reasoning system for coding problems.`
  
  switch (role) {
    case AGENT_ROLES.ANALYZER:
      return `${basePrompt} Your role is ANALYZER - you excel at problem analysis and pattern recognition. Be thorough and methodical.`
      
    case AGENT_ROLES.PLANNER:
      return `${basePrompt} Your role is PLANNER - you excel at algorithmic strategy and solution design. Be systematic and clear.`
      
    case AGENT_ROLES.CODER:
      return `${basePrompt} Your role is CODER - you excel at clean, efficient code implementation. Output ONLY executable code with minimal comments.`
      
    case AGENT_ROLES.REVIEWER:
      return `${basePrompt} Your role is REVIEWER - you excel at code review and quality assurance. Be critical but constructive.`
      
    default:
      return basePrompt
  }
}
