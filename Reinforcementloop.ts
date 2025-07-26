import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
}

interface ReinforcementRequest {
  problem_id: number
  language?: string
  max_attempts?: number
  session_id?: string // Continue existing session or start new
  initial_test_result?: any // For auto-mode integration
}

interface ReinforcementResponse {
  session_id: string
  problem_id: number
  status: 'solved' | 'in_progress' | 'max_attempts_reached'
  current_attempt: number
  best_success_rate: number
  latest_solution: {
    code: string
    reasoning: string
    success_rate: number
    test_results: any[]
  }
  improvement_summary: string[]
  total_time_spent: number
  updates?: string[]  // For auto-mode streaming
  final_success_rate?: number  // For auto-mode
  total_attempts?: number  // For auto-mode
  final_solution?: any  // For auto-mode
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { problem_id, language = 'python', max_attempts = 5, session_id, initial_test_result } = await req.json()

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

    // Get or create reinforcement session
    const sessionData = await getOrCreateSession(supabase, problem_id, max_attempts, session_id)
    
    if (sessionData.status === 'solved' || sessionData.status === 'max_attempts_reached') {
      return new Response(
        JSON.stringify(await buildResponse(supabase, sessionData)),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Run the reinforcement loop
    const result = await runReinforcementLoop(supabase, sessionData, language, initial_test_result)

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Self-Reinforcement Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function getOrCreateSession(supabase: any, problemId: number, maxAttempts: number, sessionId?: string) {
  if (sessionId) {
    // Continue existing session
    const { data: session } = await supabase
      .from('reinforcement_sessions')
      .select('*')
      .eq('id', sessionId)
      .single()
    
    if (session) return session
  }

  // Create new session
  const { data: newSession, error } = await supabase
    .from('reinforcement_sessions')
    .insert({
      problem_id: problemId,
      status: 'in_progress',
      best_success_rate: 0,
      total_attempts: 0,
      max_attempts: maxAttempts
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create session: ${error.message}`)
  return newSession
}

async function runReinforcementLoop(supabase: any, session: any, language: string, initialTestResult?: any): Promise<ReinforcementResponse> {
  const startTime = Date.now()
  let currentAttempt = session.total_attempts + 1
  let bestSuccessRate = session.best_success_rate
  let improvedInThisRun = false
  const updates: string[] = []  // Collect updates for auto-mode streaming

  while (currentAttempt <= session.max_attempts) {
    console.log(`\n🔄 Starting attempt ${currentAttempt}/${session.max_attempts} for problem ${session.problem_id}`)
    updates.push(`🔄 **ATTEMPT ${currentAttempt}/${session.max_attempts}**: Generating improved solution...\n\n`)

    try {
      // Generate solution with context from previous attempts
      const generatedSolution = await generateSolutionWithContext(supabase, session, currentAttempt, language)
      
      // Test the generated solution
      const testResults = await testGeneratedSolution(session.problem_id, generatedSolution.code, language)
      
      // Store this attempt
      await storeSolutionAttempt(supabase, session.id, session.problem_id, currentAttempt, 
                                generatedSolution, testResults, language)

      // Check if we've improved
      if (testResults.success_rate > bestSuccessRate) {
        const improvement = testResults.success_rate - bestSuccessRate
        bestSuccessRate = testResults.success_rate
        improvedInThisRun = true
        updates.push(`📈 **IMPROVEMENT**: Success rate increased from ${session.best_success_rate}% to ${testResults.success_rate}% (+${improvement.toFixed(1)}%)\n\n`)
        
        // Log the improvement
        if (currentAttempt > 1) {
          await logImprovement(supabase, session.id, currentAttempt - 1, currentAttempt, 
                              testResults.success_rate, session.best_success_rate)
        }
      } else {
        updates.push(`⚠️ **NO IMPROVEMENT**: Success rate remained at ${testResults.success_rate}%. Trying different approach...\n\n`)
      }

      // Update session
      await supabase
        .from('reinforcement_sessions')
        .update({
          total_attempts: currentAttempt,
          best_success_rate: bestSuccessRate,
          status: testResults.success_rate === 100 ? 'solved' : 'in_progress'
        })
        .eq('id', session.id)

      // If solved, mark as complete
      if (testResults.success_rate === 100) {
        await supabase
          .from('reinforcement_sessions')
          .update({
            status: 'solved',
            completed_at: new Date().toISOString()
          })
          .eq('id', session.id)

        updates.push(`🎉 **SOLVED**: Problem solved successfully in ${currentAttempt} attempts! All test cases pass.\n\n`)
        console.log(`🎉 Problem ${session.problem_id} SOLVED in ${currentAttempt} attempts!`)
        break
      }

      currentAttempt++

    } catch (error) {
      console.error(`Error in attempt ${currentAttempt}:`, error)
      currentAttempt++
    }
  }

  // If we've reached max attempts without solving
  if (currentAttempt > session.max_attempts) {
    updates.push(`⏹️ **MAX ATTEMPTS REACHED**: Stopped after ${session.max_attempts} attempts. Best success rate: ${bestSuccessRate}%\n\n`)
    
    await supabase
      .from('reinforcement_sessions')
      .update({
        status: 'max_attempts_reached',
        completed_at: new Date().toISOString()
      })
      .eq('id', session.id)
  }

  // Build final response
  const updatedSession = { ...session, total_attempts: currentAttempt - 1, best_success_rate: bestSuccessRate }
  const response = await buildResponse(supabase, updatedSession, updates)
  response.total_time_spent = (Date.now() - startTime) / 1000
  
  // Add auto-mode specific fields
  response.updates = updates
  response.final_success_rate = bestSuccessRate
  response.total_attempts = currentAttempt - 1
  
  // Get final solution for auto-mode
  if (bestSuccessRate > 0) {
    const { data: latestAttempt } = await supabase
      .from('solution_attempts')
      .select('*')
      .eq('session_id', session.id)
      .order('attempt_number', { ascending: false })
      .limit(1)
      .single()
    
    if (latestAttempt) {
      response.final_solution = {
        code: latestAttempt.generated_code,
        reasoning: latestAttempt.reasoning_content,
        success_rate: latestAttempt.success_rate
      }
    }
  }

  return response
}

async function generateSolutionWithContext(supabase: any, session: any, attemptNumber: number, language: string) {
  // Get previous attempts for context
  const { data: previousAttempts } = await supabase
    .from('solution_attempts')
    .select('*')
    .eq('session_id', session.id)
    .order('attempt_number', { ascending: true })

  // Build context prompt with previous failures
  const contextPrompt = buildContextPrompt(previousAttempts, attemptNumber)
  
  // Call AI generator with multi-agent reasoning and streaming
  const response = await fetch('https://mbuiluhrtlgyawlqchaq.supabase.co/functions/v1/code-generator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem_id: session.problem_id,
      language,
      stream: true,  // Use streaming to avoid timeout
      use_multi_agent: true,  // Enable multi-agent reasoning for better results
      context: contextPrompt,
      attempt_number: attemptNumber
    })
  })

  if (!response.ok) {
    throw new Error(`Code generation failed: ${response.status}`)
  }

  // Handle streaming response
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let reasoningContent = ''
  let codeContent = ''
  let isComplete = false

  console.log('=== STREAMING COLLECTION STARTED ===')

  while (!isComplete) {
    const { done, value } = await reader.read()
    
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)
        
        if (data === '[DONE]') {
          isComplete = true
          break
        }

        try {
          const parsed = JSON.parse(data)
          
          if (parsed.type === 'reasoning') {
            reasoningContent += parsed.content
          } else if (parsed.type === 'code') {
            // COLLECT ALL CODE CONTENT - don't filter during streaming
            codeContent += parsed.content
            console.log('Collected code chunk:', JSON.stringify(parsed.content))
          } else if (parsed.type === 'complete') {
            isComplete = true
            break
          }
        } catch (parseError) {
          console.error('Error parsing streaming response:', parseError)
        }
      }
    }
  }

  console.log('=== RAW COLLECTED CODE ===')
  console.log('Total length:', codeContent.length)
  console.log('Full content:', codeContent)
  console.log('=== PROCESSING CODE ===')

  // NOW extract the clean code from the collected content
  let cleanCode = extractPythonCodeFromText(codeContent)
  
  console.log('=== FINAL EXTRACTED CODE ===')
  console.log(cleanCode)
  console.log('=== END EXTRACTION ===')

  return {
    code: cleanCode,
    reasoning: reasoningContent.trim(),
    explanation: 'Generated via streaming'
  }
}

function extractPythonCodeFromText(text: string): string {
  console.log('Extracting Python code from text length:', text.length)
  
  // Remove markdown markers first
  let cleaned = text.replace(/```python\n?/g, '').replace(/```/g, '')
  
  // Find the actual Python code
  const lines = cleaned.split('\n')
  const codeLines: string[] = []
  let foundCode = false
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Start collecting when we see Python imports or class
    if (line.includes('from typing import') || line.includes('class Solution:')) {
      foundCode = true
      console.log('Found start of code at line:', i, line.trim())
    }
    
    if (foundCode) {
      // Stop if we hit explanation text
      if (line.trim().startsWith('###') || 
          line.trim().startsWith('Explanation') ||
          line.trim().startsWith('1.') ||
          line.trim().startsWith('This approach') ||
          line.trim().match(/^\d+\.\s+\*\*/)) {
        console.log('Found end of code at line:', i, line.trim())
        break
      }
      
      codeLines.push(line)
    }
  }
  
  const result = codeLines.join('\n').trim()
  console.log('Extracted', codeLines.length, 'lines of code')
  return result
}

function buildContextPrompt(previousAttempts: any[], currentAttempt: number): string {
  if (!previousAttempts || previousAttempts.length === 0) {
    return 'This is your first attempt at solving this problem. Focus on correctness first, then optimization.'
  }

  let context = `\n\n=== PREVIOUS ATTEMPTS ANALYSIS ===\n`
  context += `You have made ${previousAttempts.length} previous attempt(s). Learn from these failures:\n\n`

  previousAttempts.forEach((attempt, index) => {
    context += `ATTEMPT #${attempt.attempt_number}:\n`
    context += `Success Rate: ${attempt.success_rate}%\n`
    
    if (attempt.failed_test_cases && attempt.failed_test_cases.length > 0) {
      context += `Failed Test Cases:\n`
      attempt.failed_test_cases.forEach((testCase: any, i: number) => {
        context += `  Test ${i + 1}: Input ${testCase.input} → Expected: ${testCase.expected_output}, Got: ${testCase.actual_output}\n`
        if (testCase.error) {
          context += `  Error: ${testCase.error}\n`
        }
      })
    }

    if (attempt.error_messages && attempt.error_messages.length > 0) {
      context += `Errors: ${JSON.stringify(attempt.error_messages)}\n`
    }

    context += `Code that failed:\n\`\`\`\n${attempt.generated_code}\n\`\`\`\n\n`
  })

  context += `=== IMPROVEMENT STRATEGY FOR ATTEMPT #${currentAttempt} ===\n`
  context += `Based on the failures above, identify the root cause and fix it. `
  context += `Common issues: edge cases, algorithm complexity, implementation bugs, type errors.\n`
  context += `\n🎯 FOCUS AREAS FOR THIS ATTEMPT:\n`
  context += `- If same error pattern repeats, try a completely different approach\n`
  context += `- Pay special attention to edge cases that failed multiple times\n`
  context += `- Consider time/space complexity if previous solutions timed out\n`
  context += `Generate a BETTER solution that addresses these specific failures.\n\n`

  return context
}

async function testGeneratedSolution(problemId: number, solutionCode: string, language: string) {
  // EXTRACT CLEAN CODE if it contains markdown
  const cleanCode = extractCodeFromMarkdown(solutionCode, language)
  
  const response = await fetch('https://mbuiluhrtlgyawlqchaq.supabase.co/functions/v1/smart-handler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem_id: problemId,
      solution_code: cleanCode, // Use extracted clean code
      language
    })
  })

  if (!response.ok) {
    throw new Error(`Testing failed: ${response.status}`)
  }

  return await response.json()
}

function extractCodeFromMarkdown(code: string, language: string): string {
  console.log('=== CODE EXTRACTION ===')
  console.log('Input length:', code.length)
  console.log('Language:', language)
  
  // Look for code block pattern: ```language ... ```
  const codeBlockPattern = new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*?)\\n?\`\`\``, 'i')
  const match = codeBlockPattern.exec(code)
  
  if (match && match[1]) {
    const extractedCode = match[1].trim()
    console.log('✅ Extracted from markdown code block')
    console.log('Extracted length:', extractedCode.length)
    return extractedCode
  }
  
  // Fallback: Look for any ```language pattern (even if not closed)
  const openCodeBlockPattern = new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*)`, 'i')
  const openMatch = openCodeBlockPattern.exec(code)
  
  if (openMatch && openMatch[1]) {
    // Find where the code likely ends (next ``` or explanation text)
    let codeContent = openMatch[1]
    
    // Stop at closing ```
    const closingIndex = codeContent.indexOf('```')
    if (closingIndex !== -1) {
      codeContent = codeContent.substring(0, closingIndex)
    }
    
    // Stop at explanation sections
    const explanationPatterns = [
      /\n### /,
      /\n## /,
      /\n\*\*Explanation/,
      /\nThis approach/,
      /\n1\. \*\*/
    ]
    
    for (const pattern of explanationPatterns) {
      const match = pattern.exec(codeContent)
      if (match) {
        codeContent = codeContent.substring(0, match.index)
        break
      }
    }
    
    const extractedCode = codeContent.trim()
    console.log('✅ Extracted from open code block')
    console.log('Extracted length:', extractedCode.length)
    return extractedCode
  }
  
  // If no markdown found, assume it's already clean code
  console.log('⚠️ No markdown detected, using original code')
  return code.trim()
}

async function storeSolutionAttempt(supabase: any, sessionId: string, problemId: number, 
                                  attemptNumber: number, solution: any, testResults: any, language: string) {
  const { error } = await supabase
    .from('solution_attempts')
    .insert({
      session_id: sessionId,
      problem_id: problemId,
      attempt_number: attemptNumber,
      generated_code: solution.code,
      reasoning_content: solution.reasoning,
      explanation: solution.explanation,          // NEW: Store explanation for UI
      full_response: solution.full_response,      // NEW: Store complete response
      language,
      success_rate: testResults.success_rate,
      failed_test_cases: testResults.test_results.filter((t: any) => !t.passed),
      error_messages: testResults.test_results.filter((t: any) => t.error).map((t: any) => t.error)
    })

  if (error) {
    console.error('Failed to store solution attempt:', error)
  }
}

async function logImprovement(supabase: any, sessionId: string, fromAttempt: number, 
                             toAttempt: number, newSuccessRate: number, oldSuccessRate: number) {
  const improvement = newSuccessRate - oldSuccessRate
  const strategy = determineImprovementStrategy(improvement, newSuccessRate)
  
  await supabase
    .from('improvement_logs')
    .insert({
      session_id: sessionId,
      from_attempt: fromAttempt,
      to_attempt: toAttempt,
      changes_made: `Success rate improved from ${oldSuccessRate}% to ${newSuccessRate}% (+${improvement.toFixed(1)}%)`,
      improvement_strategy: strategy
    })
}

function determineImprovementStrategy(improvement: number, successRate: number): string {
  if (successRate === 100) return 'problem_solved'
  if (improvement >= 50) return 'major_algorithm_fix'
  if (improvement >= 20) return 'significant_bug_fix'
  if (improvement > 0) return 'minor_improvement'
  return 'no_improvement'
}

async function buildResponse(supabase: any, session: any, updates: string[] = []): Promise<ReinforcementResponse> {
  // Get latest attempt
  const { data: latestAttempt } = await supabase
    .from('solution_attempts')
    .select('*')
    .eq('session_id', session.id)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .single()

  // Get improvement summary
  const { data: improvements } = await supabase
    .from('improvement_logs')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  const improvementSummary = improvements?.map(imp => imp.changes_made) || []

  return {
    session_id: session.id,
    problem_id: session.problem_id,
    status: session.status,
    current_attempt: session.total_attempts,
    best_success_rate: session.best_success_rate,
    latest_solution: {
      code: latestAttempt?.generated_code || '',
      reasoning: latestAttempt?.reasoning_content || '',
      success_rate: latestAttempt?.success_rate || 0,
      test_results: latestAttempt?.failed_test_cases || []
    },
    improvement_summary: improvementSummary,
    total_time_spent: 0 // Will be set by caller
  }
}