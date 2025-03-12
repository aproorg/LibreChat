import fs from 'fs';
import path from 'path';

// Test loading config configuration
const testLoadConfig = (config) => {
  try {
    const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
    const configConfigPath = path.join(configRepoPath, 'config-styles', config, 'theme.json');
    
    if (!fs.existsSync(configConfigPath)) {
      console.error(`Config configuration not found for ${config}`);
      return null;
    }

    const configConfig = JSON.parse(fs.readFileSync(configConfigPath, 'utf8'));
    console.log(`Successfully loaded config configuration for ${config}`);
    return configConfig;
  } catch (error) {
    console.error(`Error loading config configuration: ${error.message}`);
    return null;
  }
};

// Test generating config CSS
const testGenerateCSS = (config, config) => {
  try {
    if (!config) {
      console.error('No configuration provided');
      return false;
    }
    
    const configStylesDir = path.resolve(process.cwd(), 'src/config-styles');
    
    if (!fs.existsSync(configStylesDir)) {
      fs.mkdirSync(configStylesDir, { recursive: true });
    }
    
    // Path to config's Tailwind config
    const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
    const tailwindConfigPath = path.relative(
      configStylesDir,
      path.join(configRepoPath, 'config-styles', config, 'tailwind.config.mjs')
    );
    
    // Generate CSS content
    let cssContent = `@config "${tailwindConfigPath}";\n\n`;
    cssContent += `@tailwind base;\n`;
    cssContent += `@tailwind components;\n`;
    cssContent += `@tailwind utilities;\n\n`;
    cssContent += `/* Import base styles */\n`;
    cssContent += `@import "../style.css";\n\n`;
    cssContent += `/* Config-specific styles */\n`;
    cssContent += `:root {\n`;
    
    // Add CSS variables from theme.json
    if (config.cssVariables) {
      for (const [variable, value] of Object.entries(config.cssVariables)) {
        cssContent += `  ${variable}: ${value};\n`;
      }
    }
    
    cssContent += `}\n\n`;
    cssContent += `/* Additional config-specific styles */\n`;
    cssContent += `.config-${config} {\n`;
    cssContent += `  /* Custom styles for this config */\n`;
    cssContent += `}\n`;
    
    // Write CSS file
    const outputPath = path.join(configStylesDir, `${config}-test.css`);
    fs.writeFileSync(outputPath, cssContent);
    console.log(`Generated CSS file for config ${config}: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`Error generating CSS: ${error.message}`);
    return false;
  }
};

// Run tests
const runTests = () => {
  const configs = ['default', 'apro', 'byko'];
  
  for (const config of configs) {
    console.log(`\n=== Testing ${config} config ===`);
    const config = testLoadConfig(config);
    
    if (config) {
      const cssGenerated = testGenerateCSS(config, config);
      if (cssGenerated) {
        console.log(`✅ ${config} config test passed`);
      } else {
        console.error(`❌ ${config} config CSS generation failed`);
      }
    } else {
      console.error(`❌ ${config} config configuration loading failed`);
    }
  }
};

runTests();
