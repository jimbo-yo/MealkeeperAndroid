// Demo meals shown on first launch, and the example export used in the AI prompt and "Load sample export".
// Field names follow the app's own meal shape (see cleanMeal in app.js); SAMPLE_EXPORT uses the mealkeeper-v1 format.

const DEMO_MEALS = [
  {
    id: 1,
    name: 'Sunday Italian supper',
    desc: 'A relaxed family meal with a shared prep plan.',
    emoji: '🍝',
    art: 'pasta',
    tag: 'THIS WEEKEND',
    time: '55 min',
    servings: 3,
    serveAt: '18:30',
    recipes: [
      {
        id: 'bruschetta',
        icon: '🍅',
        title: 'Roasted tomato bruschetta',
        course: 'Starter',
        servings: 3,
        prep: 10,
        cook: 5,
        time: '15 min',
        ingredients: [
          {name: 'Baguette', quantity: 1, unit: '', notes: 'sliced'},
          {name: 'Cherry tomatoes', quantity: 1, unit: 'pint', notes: 'quartered'},
          {name: 'Fresh basil', quantity: 0.5, unit: 'bunch', notes: 'torn'},
          {name: 'Garlic', quantity: 1, unit: 'clove', notes: 'halved'},
          {name: 'Olive oil', quantity: 2, unit: 'tbsp', notes: ''},
          {name: 'Balsamic glaze', quantity: 1, unit: 'tbsp', notes: ''}
        ],
        instructions: [
          'Toast the baguette slices until golden, then rub with the cut garlic.',
          'Mix tomatoes, basil, olive oil and a pinch of salt.',
          'Spoon onto the toasts just before serving and drizzle with balsamic glaze.'
        ],
        makeAhead: 'Mix the topping up to 2 hours ahead; keep it separate from the toast.'
      },
      {
        id: 'rigatoni',
        icon: '🍝',
        title: 'Sausage & pepper rigatoni',
        course: 'Main',
        servings: 3,
        prep: 10,
        cook: 25,
        time: '35 min',
        ingredients: [
          {name: 'Italian sausage links', quantity: 1, unit: 'lb', notes: 'casings removed'},
          {name: 'Rigatoni pasta', quantity: 12, unit: 'oz', notes: ''},
          {name: 'Bell peppers', quantity: 2, unit: '', notes: 'sliced'},
          {name: 'Garlic', quantity: 3, unit: 'cloves', notes: 'minced'},
          {name: 'Heavy cream', quantity: 0.5, unit: 'cup', notes: ''},
          {name: 'Parmesan', quantity: 0.5, unit: 'cup', notes: 'grated'},
          {name: 'Olive oil', quantity: 1, unit: 'tbsp', notes: ''}
        ],
        instructions: [
          'Brown the sausage in olive oil, breaking it up as it cooks.',
          'Add peppers and garlic and cook until soft, about 8 minutes.',
          'Stir in the cream and simmer gently while the pasta cooks.',
          'Boil rigatoni until al dente, reserving a cup of pasta water.',
          'Toss pasta with the sauce and parmesan, loosening with pasta water as needed.'
        ]
      },
      {
        id: 'ricotta',
        icon: '🍋',
        title: 'Lemon ricotta cups',
        course: 'Dessert',
        servings: 3,
        prep: 10,
        cook: 0,
        time: '10 min',
        ingredients: [
          {name: 'Ricotta cheese', quantity: 1, unit: 'cup', notes: ''},
          {name: 'Lemons', quantity: 1, unit: '', notes: 'zested'},
          {name: 'Honey', quantity: 2, unit: 'tbsp', notes: ''}
        ],
        instructions: [
          'Whisk ricotta with lemon zest and honey until smooth.',
          'Spoon into small cups and chill until dessert.'
        ]
      }
    ],
    shopping: [
      {
        name: 'Italian sausage links',
        qty: '1 lb',
        group: 'Meat & seafood',
        usedIn: ['Sausage & pepper rigatoni']
      },
      {name: 'Rigatoni pasta', qty: '12 oz', group: 'Pantry', usedIn: ['Sausage & pepper rigatoni']},
      {name: 'Bell peppers', qty: '2', group: 'Produce', usedIn: ['Sausage & pepper rigatoni']},
      {name: 'Cherry tomatoes', qty: '1 pint', group: 'Produce', usedIn: ['Roasted tomato bruschetta']},
      {name: 'Fresh basil', qty: '1 bunch', group: 'Produce', usedIn: ['Roasted tomato bruschetta']},
      {name: 'Ricotta cheese', qty: '1 cup', group: 'Dairy', usedIn: ['Lemon ricotta cups']},
      {name: 'Lemons', qty: '2', group: 'Produce', usedIn: ['Lemon ricotta cups']},
      {
        name: 'Olive oil',
        qty: 'as needed',
        group: 'Pantry',
        usedIn: ['Roasted tomato bruschetta', 'Sausage & pepper rigatoni']
      },
      {
        name: 'Garlic',
        qty: '1 bulb',
        group: 'Produce',
        usedIn: ['Roasted tomato bruschetta', 'Sausage & pepper rigatoni']
      },
      {name: 'Parmesan', qty: '½ cup', group: 'Dairy', usedIn: ['Sausage & pepper rigatoni']},
      {name: 'Balsamic glaze', qty: '1 small bottle', group: 'Pantry', usedIn: ['Roasted tomato bruschetta']},
      {name: 'Heavy cream', qty: '½ cup', group: 'Dairy', usedIn: ['Sausage & pepper rigatoni']},
      {name: 'Baguette', qty: '1', group: 'Bakery', usedIn: ['Roasted tomato bruschetta']},
      {name: 'Honey', qty: '2 tbsp', group: 'Pantry', usedIn: ['Lemon ricotta cups']}
    ],
    timeline: [
      {
        offset: 0,
        duration: 10,
        task: 'Prep everything',
        details: 'Wash produce, mince garlic, slice peppers, and set out ingredients.'
      },
      {
        offset: 10,
        duration: 30,
        task: 'Start the sausage & pepper sauce',
        recipeId: 'rigatoni',
        details: 'Brown sausage, soften peppers and garlic, add cream, then simmer while pasta water heats.'
      },
      {
        offset: 25,
        duration: 10,
        task: 'Prepare bruschetta',
        recipeId: 'bruschetta',
        details: 'Toast bread and mix tomatoes, basil, olive oil, and garlic. Keep separate until serving.'
      },
      {
        offset: 30,
        duration: 12,
        task: 'Boil pasta',
        recipeId: 'rigatoni',
        details: 'Cook rigatoni until al dente. Reserve a cup of pasta water before draining.'
      },
      {
        offset: 40,
        duration: 10,
        task: 'Finish and plate the main',
        recipeId: 'rigatoni',
        details: 'Toss pasta with sauce and parmesan. Set bruschetta out as the first course.'
      },
      {
        offset: 50,
        duration: 5,
        task: 'Finish lemon ricotta cups',
        recipeId: 'ricotta',
        details: 'Add lemon zest and a little honey; garnish and chill until dessert.'
      }
    ]
  },
  {
    id: 2,
    name: 'Weeknight quinoa bowls',
    desc: 'Flexible bowls with roasted vegetables and a bright dressing.',
    emoji: '🥗',
    art: '',
    tag: 'WEEKDAY FAVORITE',
    time: '30 min',
    servings: 3,
    recipes: [
      {icon: '🥣', title: 'Herby quinoa base', course: 'Base', time: '20 min'},
      {icon: '🥦', title: 'Roasted veg & tahini sauce', course: 'Toppings', time: '25 min'}
    ]
  },
  {
    id: 3,
    name: 'Cozy autumn dinner',
    desc: 'A warming, oven-friendly meal with minimal hands-on time.',
    emoji: '🍲',
    art: 'soup',
    tag: 'MAKE AHEAD',
    time: '1 hr 10 min',
    servings: 4,
    recipes: [
      {icon: '🍗', title: 'Braised chicken thighs', course: 'Main', time: '50 min'},
      {icon: '🎃', title: 'Maple roasted squash', course: 'Side', time: '30 min'},
      {icon: '🥬', title: 'Garlicky greens', course: 'Side', time: '10 min'}
    ]
  },
  {
    id: 4,
    name: 'Taco night',
    desc: 'Build-your-own tacos with a simple prep sequence.',
    emoji: '🌮',
    art: 'taco',
    tag: 'QUICK & EASY',
    time: '35 min',
    servings: 3,
    recipes: [
      {icon: '🌮', title: 'Smoky beef tacos', course: 'Main', time: '25 min'},
      {icon: '🥑', title: 'Avocado lime salsa', course: 'Topping', time: '10 min'},
      {icon: '🌽', title: 'Chili-lime corn', course: 'Side', time: '12 min'}
    ]
  }
];

const SAMPLE_EXPORT = {
  format: 'mealkeeper-v1',
  meals: [
    {
      name: 'Mediterranean chicken bowls',
      description: 'A bright make-ahead dinner.',
      servings: 3,
      total_time: '30 min',
      recipes: [
        {
          id: 'chicken',
          title: 'Lemon herb chicken',
          course: 'Main',
          servings: 3,
          prep_time_minutes: 10,
          cook_time_minutes: 15,
          total_time_minutes: 25,
          ingredients: [
            {name: 'Chicken thighs', quantity: 1.5, unit: 'lb', notes: 'boneless'},
            {name: 'Lemon', quantity: 1, unit: null, notes: 'zested and juiced'},
            {name: 'Garlic', quantity: 2, unit: 'cloves', notes: 'minced'},
            {name: 'Olive oil', quantity: 2, unit: 'tbsp', notes: null}
          ],
          instructions: [
            'Toss the chicken with lemon, garlic, olive oil, salt and pepper.',
            'Sear over medium-high heat 6–7 minutes per side until cooked through.',
            'Rest 5 minutes, then slice.'
          ],
          make_ahead_notes: 'Marinate up to 1 day ahead.',
          source: null
        },
        {
          id: 'salad',
          title: 'Cucumber tomato salad',
          course: 'Side',
          servings: 3,
          prep_time_minutes: 10,
          cook_time_minutes: 0,
          total_time_minutes: 10,
          ingredients: [
            {name: 'Cucumber', quantity: 1, unit: null, notes: null},
            {name: 'Cherry tomatoes', quantity: 1, unit: 'pint', notes: 'halved'},
            {name: 'Olive oil', quantity: 1, unit: 'tbsp', notes: null}
          ],
          instructions: [
            'Chop the cucumber and halve the tomatoes.',
            'Dress with olive oil, salt and pepper just before serving.'
          ],
          make_ahead_notes: null,
          source: null
        }
      ],
      shopping_list: [
        {name: 'Chicken thighs', quantity: 1.5, unit: 'lb', category: 'Meat & seafood', used_in: ['chicken']},
        {name: 'Lemon', quantity: 1, unit: null, category: 'Produce', used_in: ['chicken']},
        {name: 'Garlic', quantity: 2, unit: 'cloves', category: 'Produce', used_in: ['chicken']},
        {name: 'Cucumber', quantity: 1, unit: null, category: 'Produce', used_in: ['salad']},
        {name: 'Cherry tomatoes', quantity: 1, unit: 'pint', category: 'Produce', used_in: ['salad']},
        {name: 'Olive oil', quantity: 3, unit: 'tbsp', category: 'Pantry', used_in: ['chicken', 'salad']}
      ],
      timeline: [
        {
          start_offset_minutes: 0,
          duration_minutes: 10,
          task: 'Marinate the chicken',
          recipe_id: 'chicken',
          instructions: 'Toss the chicken with lemon, garlic and oil.'
        },
        {
          start_offset_minutes: 10,
          duration_minutes: 15,
          task: 'Cook the chicken',
          recipe_id: 'chicken',
          instructions: 'Sear until cooked through.'
        },
        {
          start_offset_minutes: 15,
          duration_minutes: 10,
          task: 'Make the salad',
          recipe_id: 'salad',
          instructions: 'Chop and dress just before serving.'
        },
        {
          start_offset_minutes: 25,
          duration_minutes: 5,
          task: 'Rest and slice the chicken',
          recipe_id: 'chicken',
          instructions: null
        }
      ]
    }
  ]
};
