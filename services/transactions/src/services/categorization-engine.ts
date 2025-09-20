import type {
  CategorizationRule,
  CategorizationSuggestion,
  TransactionDirection,
} from '../domain/models';

export interface CategorizationInput {
  merchantName: string;
  description?: string | null;
  amount: string;
  direction: TransactionDirection;
}

export class CategorizationEngine {
  constructor(private readonly rules: CategorizationRule[]) {}

  suggest(input: CategorizationInput): CategorizationSuggestion | null {
    const ruleSuggestion = this.applyRules(input);
    if (ruleSuggestion) {
      return ruleSuggestion;
    }

    return this.applyMlPlaceholder(input);
  }

  private applyRules(input: CategorizationInput): CategorizationSuggestion | null {
    const merchant = input.merchantName.toLowerCase();
    const description = (input.description ?? '').toLowerCase();
    const amount = Number.parseFloat(input.amount);

    for (const rule of this.rules) {
      if (!rule.isActive) {
        continue;
      }

      const matchValue = rule.matchValue.toLowerCase();

      let isMatch = false;
      switch (rule.matchType) {
        case 'merchant_equals':
          isMatch = merchant === matchValue;
          break;
        case 'merchant_contains':
          isMatch = merchant.includes(matchValue);
          break;
        case 'description_contains':
          isMatch = description.includes(matchValue);
          break;
        case 'amount_greater_than':
          isMatch = Number.isFinite(amount) && amount > Number.parseFloat(rule.matchValue);
          break;
        case 'amount_less_than':
          isMatch = Number.isFinite(amount) && amount < Number.parseFloat(rule.matchValue);
          break;
        default:
          isMatch = false;
      }

      if (isMatch) {
        return {
          categoryId: rule.categoryId ?? null,
          tags: [...rule.tags],
          confidence: 0.9,
          source: 'rule',
        };
      }
    }

    return null;
  }

  private applyMlPlaceholder(input: CategorizationInput): CategorizationSuggestion | null {
    const normalized = `${input.merchantName} ${input.description ?? ''}`.toLowerCase();
    const amount = Number.parseFloat(input.amount);

    const mappings: {
      keywords: string[];
      categoryId: string;
      tags: string[];
      confidence: number;
      direction?: TransactionDirection;
    }[] = [
      {
        keywords: ['coffee', 'cafe', 'starbucks', 'peet', 'dunkin'],
        categoryId: 'cat-coffee',
        tags: ['coffee'],
        confidence: 0.68,
      },
      {
        keywords: ['market', 'grocery', 'whole foods', 'trader joe', 'costco', 'aldi', 'safeway'],
        categoryId: 'cat-groceries',
        tags: ['groceries'],
        confidence: 0.72,
      },
      {
        keywords: ['uber', 'lyft', 'taxi', 'ride', 'transport'],
        categoryId: 'cat-transport',
        tags: ['transport'],
        confidence: 0.62,
      },
      {
        keywords: ['netflix', 'hulu', 'spotify', 'youtube', 'disney'],
        categoryId: 'cat-entertainment',
        tags: ['streaming'],
        confidence: 0.6,
      },
      {
        keywords: ['energy', 'electric', 'water', 'utility', 'comcast', 'verizon'],
        categoryId: 'cat-utilities',
        tags: ['utilities'],
        confidence: 0.57,
      },
      {
        keywords: ['payroll', 'paycheck', 'salary', 'direct deposit'],
        categoryId: 'cat-income',
        tags: ['income'],
        confidence: 0.78,
        direction: 'credit',
      },
    ];

    for (const mapping of mappings) {
      if (mapping.direction && mapping.direction !== input.direction) {
        continue;
      }

      if (mapping.keywords.some((keyword) => normalized.includes(keyword))) {
        return {
          categoryId: mapping.categoryId,
          tags: [...mapping.tags],
          confidence: mapping.confidence,
          source: 'ml',
        };
      }
    }

    if (Number.isFinite(amount) && amount >= 500 && input.direction === 'debit') {
      return {
        categoryId: 'cat-large-purchase',
        tags: ['review'],
        confidence: 0.4,
        source: 'ml',
      };
    }

    return null;
  }
}
