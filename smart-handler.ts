import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
};
// Judge0 API Configuration
const JUDGE0_API_URL = 'https://judge0-ce.p.rapidapi.com';
const RAPIDAPI_KEY = '2ffabb17ebmshcaccacc199044b9p1ef187jsn2f0e1fe002ef';
const RAPIDAPI_HOST = 'judge0-ce.p.rapidapi.com';
// Common language IDs for Judge0
const LANGUAGE_IDS = {
  'python': 71,
  'java': 62,
  'cpp': 54,
  'javascript': 63,
  'c': 50,
  'go': 60,
  'rust': 73
};
serve(async (req)=>{
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    const { problem_id, solution_code, language = 'python' } = await req.json();
    if (!problem_id || !solution_code) {
      return new Response(JSON.stringify({
        error: 'Missing problem_id or solution_code'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ⭐ EXTRACT CLEAN CODE - Remove markdown and explanatory text
    const cleanCode = extractCleanCode(solution_code, language);
    console.log('Original code length:', solution_code.length);
    console.log('Clean code length:', cleanCode.length);
    // Initialize Supabase client
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // Fetch problem from database
    const { data: problem, error: dbError } = await supabase.from('problems').select('*').eq('id', problem_id).single();
    if (dbError || !problem) {
      return new Response(JSON.stringify({
        error: 'Problem not found'
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Parse test cases and parameter map
    const testCases = parseTestCases(problem.test_cases);
    const parameterMap = parseParameterMap(problem.parameter_map);
    console.log('Parsed test cases:', testCases);
    console.log('Parameter map:', parameterMap);
    // Execute tests using Judge0 with CLEAN CODE
    const executionResult = await executeTests(cleanCode, testCases, parameterMap, language);
    // Store results in database (optional)
    const { error: insertError } = await supabase.from('test_results').insert({
      problem_id,
      original_code: solution_code,
      clean_code: cleanCode,
      language,
      success_rate: executionResult.success_rate,
      total_tests: executionResult.total_tests,
      passed_tests: executionResult.passed_tests,
      results: executionResult.test_results,
      created_at: new Date().toISOString()
    });
    if (insertError) {
      console.error('Failed to store results:', insertError);
    }
    return new Response(JSON.stringify({
      ...executionResult,
      extraction_info: {
        original_length: solution_code.length,
        clean_length: cleanCode.length,
        extraction_successful: cleanCode !== solution_code
      }
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
function parseTestCases(testCasesString) {
  try {
    // Handle format: "([2, 7, 11, 15], 9, [0, 1]), ([3, 2, 4], 6, [1, 2])"
    // or: "('babad', 'bab'), ('cbbd', 'bb')"
    const testCases = [];
    // Split by '), (' to get individual test cases
    const cases = testCasesString.split('), (');
    for(let i = 0; i < cases.length; i++){
      let caseStr = cases[i];
      // Clean up the string
      caseStr = caseStr.replace(/^\(/, '').replace(/\)$/, '');
      // Split by comma but be careful with arrays
      const parts = smartSplit(caseStr);
      testCases.push(parts);
    }
    return testCases;
  } catch (error) {
    console.error('Error parsing test cases:', error);
    return [];
  }
}
function smartSplit(str) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;
  let quoteChar = '';
  for(let i = 0; i < str.length; i++){
    const char = str[i];
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      current += char;
    } else if (!inQuotes && char === '[') {
      depth++;
      current += char;
    } else if (!inQuotes && char === ']') {
      depth--;
      current += char;
    } else if (!inQuotes && char === ',' && depth === 0) {
      parts.push(parseValue(current.trim()));
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(parseValue(current.trim()));
  }
  return parts;
}
function parseValue(str) {
  str = str.trim();
  // Handle arrays
  if (str.startsWith('[') && str.endsWith(']')) {
    try {
      return JSON.parse(str);
    } catch  {
      return str;
    }
  }
  // Handle strings
  if (str.startsWith('"') && str.endsWith('"') || str.startsWith("'") && str.endsWith("'")) {
    return str.slice(1, -1);
  }
  // Handle numbers
  if (!isNaN(Number(str))) {
    return Number(str);
  }
  return str;
}
function parseParameterMap(parameterMapString) {
  // Handle format: "nums, target, output" or "s, output"
  return parameterMapString.split(',').map((param)=>param.trim());
}
async function executeTests(solutionCode, testCases, parameterMap, language) {
  const languageId = LANGUAGE_IDS[language] || LANGUAGE_IDS['python'];
  const results = [];
  for (const testCase of testCases){
    try {
      // Separate inputs from expected output
      const inputs = testCase.slice(0, -1) // All but last element
      ;
      const expectedOutput = testCase[testCase.length - 1] // Last element
      ;
      // Create the complete solution code with test input
      const completeCode = createCompleteCode(solutionCode, inputs, parameterMap, language);
      // Submit to Judge0
      const submissionResult = await submitToJudge0(completeCode, languageId);
      // Process result
      const testResult = {
        input: JSON.stringify(inputs),
        expected_output: JSON.stringify(expectedOutput),
        actual_output: submissionResult.stdout || '',
        passed: false,
        execution_time: submissionResult.time || 0,
        memory_used: submissionResult.memory || 0,
        status: submissionResult.status?.description || 'Unknown'
      };
      if (submissionResult.stderr) {
        testResult.error = submissionResult.stderr;
      }
      // Check if test passed
      if (submissionResult.status?.id === 3) {
        try {
          const actualOutputStr = submissionResult.stdout.trim();
          const actualOutput = JSON.parse(actualOutputStr);
          testResult.actual_output = actualOutputStr;
          testResult.passed = JSON.stringify(actualOutput) === JSON.stringify(expectedOutput);
        } catch (parseError) {
          // If JSON parsing fails, compare as strings
          testResult.actual_output = submissionResult.stdout.trim();
          testResult.passed = submissionResult.stdout.trim() === JSON.stringify(expectedOutput);
        }
      }
      results.push(testResult);
    } catch (error) {
      console.error('Error executing test case:', error);
      results.push({
        input: JSON.stringify(testCase.slice(0, -1)),
        expected_output: JSON.stringify(testCase[testCase.length - 1]),
        actual_output: '',
        passed: false,
        execution_time: 0,
        memory_used: 0,
        status: 'Error',
        error: error.message
      });
    }
  }
  const passedTests = results.filter((r)=>r.passed).length;
  const totalTests = results.length;
  return {
    success_rate: totalTests > 0 ? passedTests / totalTests * 100 : 0,
    total_tests: totalTests,
    passed_tests: passedTests,
    failed_tests: totalTests - passedTests,
    test_results: results,
    overall_status: passedTests === totalTests ? 'All Passed' : 'Some Failed'
  };
}
function createCompleteCode(solutionCode, inputs, parameterMap, language) {
  if (language === 'python') {
    const functionName = extractFunctionNameFromCode(solutionCode);
    const testCode = `from typing import List
import json

${solutionCode}

# Test execution
if __name__ == "__main__":
    solution = Solution()
    ${generatePythonTestCall(inputs, parameterMap, functionName)}
`;
    return testCode;
  }
  // Add support for other languages later
  return solutionCode;
}
function extractFunctionNameFromCode(code) {
  // Extract function name from solution code
  const match = code.match(/def\s+(\w+)\s*\(/);
  return match ? match[1] : 'solve';
}
function generatePythonTestCall(inputs, parameterMap, functionName) {
  // Remove 'output' from parameter map to get function parameters
  const functionParams = parameterMap.filter((param)=>param !== 'output');
  if (functionParams.length === 1) {
    return `result = solution.${functionName}(${JSON.stringify(inputs[0])})
    print(json.dumps(result))`;
  } else if (functionParams.length === 2) {
    return `result = solution.${functionName}(${JSON.stringify(inputs[0])}, ${JSON.stringify(inputs[1])})
    print(json.dumps(result))`;
  }
  // Handle more parameters as needed
  return `print("Error: Unsupported parameter count")`;
}
function getFunctionName(param) {
  // Map parameter names to likely function names
  const functionMap = {
    'nums': 'twoSum',
    's': 'longestPalindrome',
    'l1': 'addTwoNumbers',
    'l2': 'addTwoNumbers'
  };
  return functionMap[param] || 'solve';
}
async function submitToJudge0(sourceCode, languageId) {
  try {
    // Encode source code in base64
    const encodedSourceCode = btoa(sourceCode);
    // Submit code
    const submitResponse = await fetch(`${JUDGE0_API_URL}/submissions?base64_encoded=true&wait=false&fields=*`, {
      method: 'POST',
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        language_id: languageId,
        source_code: encodedSourceCode,
        stdin: ''
      })
    });
    const submissionData = await submitResponse.json();
    if (!submissionData.token) {
      throw new Error('Failed to submit code to Judge0');
    }
    // Poll for results
    let result;
    let attempts = 0;
    const maxAttempts = 30 // 30 seconds timeout
    ;
    do {
      await new Promise((resolve)=>setTimeout(resolve, 1000)) // Wait 1 second
      ;
      const resultResponse = await fetch(`${JUDGE0_API_URL}/submissions/${submissionData.token}?base64_encoded=true&fields=*`, {
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST
        }
      });
      result = await resultResponse.json();
      attempts++;
    }while (result.status?.id <= 2 && attempts < maxAttempts) // Status 1=queued, 2=processing
    // Decode base64 outputs
    if (result.stdout) {
      result.stdout = atob(result.stdout);
    }
    if (result.stderr) {
      result.stderr = atob(result.stderr);
    }
    if (result.compile_output) {
      result.compile_output = atob(result.compile_output);
    }
    return result;
  } catch (error) {
    console.error('Judge0 API Error:', error);
    throw error;
  }
}
function extractCleanCode(code, language) {
  console.log('=== SMART HANDLER CODE EXTRACTION ===');
  console.log('Input code length:', code.length);
  console.log('Target language:', language);
  console.log('First 200 chars:', code.substring(0, 200));
  // Pattern 1: Standard markdown code block ```language ... ```
  const standardPattern = new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*?)\\n?\`\`\``, 'i');
  const standardMatch = standardPattern.exec(code);
  if (standardMatch && standardMatch[1]) {
    const extracted = standardMatch[1].trim();
    console.log('✅ SUCCESS: Extracted via standard markdown pattern');
    console.log('Extracted code preview:', extracted.substring(0, 150) + '...');
    return extracted;
  }
  // Pattern 2: Open code block without closing ```language ... (text)
  const openPattern = new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*)`, 'i');
  const openMatch = openPattern.exec(code);
  if (openMatch && openMatch[1]) {
    let codeContent = openMatch[1];
    // Find natural stopping points
    const stopPatterns = [
      '```',
      '\n### ',
      '\n## ',
      '\nExplanation',
      '\nThis approach',
      '\n1. **',
      '\n2. **',
      '\nTime Complexity',
      '\nSpace Complexity'
    ];
    let earliestStop = codeContent.length;
    for (const pattern of stopPatterns){
      const index = codeContent.indexOf(pattern);
      if (index !== -1 && index < earliestStop) {
        earliestStop = index;
      }
    }
    codeContent = codeContent.substring(0, earliestStop).trim();
    console.log('✅ SUCCESS: Extracted via open block pattern');
    console.log('Extracted code preview:', codeContent.substring(0, 150) + '...');
    return codeContent;
  }
  // Pattern 3: Look for class Solution directly (no markdown)
  if (language === 'python') {
    // Find from "from typing import" or "class Solution" to end of code
    const lines = code.split('\n');
    let startIndex = -1;
    let endIndex = lines.length;
    // Find start
    for(let i = 0; i < lines.length; i++){
      if (lines[i].includes('from typing import') || lines[i].includes('class Solution:')) {
        startIndex = i;
        break;
      }
    }
    if (startIndex !== -1) {
      // Find end (explanation text)
      for(let i = startIndex + 1; i < lines.length; i++){
        const line = lines[i].trim();
        if (line.startsWith('###') || line.startsWith('Explanation') || line.startsWith('This ') || line.startsWith('The ') || line.match(/^\d+\.\s+\*\*/)) {
          endIndex = i;
          break;
        }
      }
      const extractedLines = lines.slice(startIndex, endIndex);
      const extracted = extractedLines.join('\n').trim();
      if (extracted.includes('class Solution:')) {
        console.log('✅ SUCCESS: Extracted via class detection');
        console.log('Extracted code preview:', extracted.substring(0, 150) + '...');
        return extracted;
      }
    }
  }
  // Pattern 4: No extraction needed (already clean)
  if (code.includes('class Solution:') && !code.includes('```')) {
    console.log('✅ Code appears to be already clean');
    return code.trim();
  }
  // Fallback: return original
  console.log('⚠️ FALLBACK: No extraction pattern matched, returning original');
  console.log('This might cause syntax errors!');
  return code;
}
