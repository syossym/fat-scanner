/**
 * Generates realistic sample nutrition label canvases for instant on-device OCR testing.
 * Cycles between an EU/UK per-100g label, a US per-serving Nutrition Facts label,
 * and a round circular tub lid label with compact linear Nutrition Facts.
 */

let sampleIndex = 0;

export function createSampleLabelCanvas() {
  const idx = sampleIndex % 3;
  sampleIndex++;
  if (idx === 0) return renderEuGranolaLabel();
  if (idx === 1) return renderUsNutritionFactsLabel();
  return renderRoundLidLabel();
}

function renderEuGranolaLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 680;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#faf8f4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1d1d1b';
  ctx.lineWidth = 4;
  ctx.fillRect(40, 36, 680, 608);
  ctx.strokeRect(40, 36, 680, 608);

  ctx.fillStyle = '#141414';
  ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
  ctx.fillText('Nutrition Information', 68, 94);

  ctx.fillRect(64, 114, 632, 6);

  ctx.font = 'bold 24px Arial, Helvetica, sans-serif';
  ctx.fillText('Typical Values', 68, 154);
  ctx.fillText('Per 100g', 405, 154);
  ctx.fillText('Per 45g', 562, 154);

  ctx.fillRect(64, 172, 632, 3);

  const rows = [
    ['Energy', '1842 kJ', '829 kJ', false],
    ['', '440 kcal', '198 kcal', false],
    ['Fat', '16.4g', '7.4g', true],
    ['  of which saturates', '2.8g', '1.3g', false],
    ['Carbohydrate', '58.2g', '26.2g', false],
    ['  of which sugars', '12.5g', '5.6g', false],
    ['Fibre', '8.4g', '3.8g', false],
    ['Protein', '11.2g', '5.0g', false],
    ['Salt', '0.32g', '0.14g', false],
  ];

  let y = 218;
  for (const [label, col100, colServ, bold] of rows) {
    ctx.font = bold ? 'bold 26px Arial, Helvetica, sans-serif' : '24px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#141414';
    ctx.fillText(label, 68, y);
    ctx.fillText(col100, 405, y);
    ctx.fillText(colServ, 562, y);

    if (label !== 'Energy') {
      ctx.fillStyle = '#cccccc';
      ctx.fillRect(64, y + 14, 632, 1.5);
    }
    y += 47;
  }

  return {
    canvas,
    name: 'Sample: Oat Granola (EU label)',
  };
}

function renderUsNutritionFactsLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 660;
  canvas.height = 780;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#faf8f4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 4;
  ctx.fillRect(46, 36, 568, 708);
  ctx.strokeRect(46, 36, 568, 708);

  ctx.fillStyle = '#111111';
  ctx.font = '900 50px Arial, Helvetica, sans-serif';
  ctx.fillText('Nutrition Facts', 70, 102);

  ctx.fillRect(66, 118, 528, 2);

  ctx.font = '25px Arial, Helvetica, sans-serif';
  ctx.fillText('8 servings per container', 70, 152);

  ctx.font = 'bold 28px Arial, Helvetica, sans-serif';
  ctx.fillText('Serving size', 70, 192);
  ctx.fillText('2/3 cup (55g)', 390, 192);

  ctx.fillRect(66, 208, 528, 16);

  ctx.font = 'bold 22px Arial, Helvetica, sans-serif';
  ctx.fillText('Amount per serving', 70, 248);

  ctx.font = '900 42px Arial, Helvetica, sans-serif';
  ctx.fillText('Calories', 70, 298);
  ctx.fillText('230', 505, 298);

  ctx.fillRect(66, 314, 528, 8);

  ctx.font = 'bold 21px Arial, Helvetica, sans-serif';
  ctx.fillText('% Daily Value*', 445, 344);
  ctx.fillRect(66, 356, 528, 2);

  const items = [
    ['Total Fat 8g', '10%', true, 0],
    ['Saturated Fat 1g', '5%', false, 24],
    ['Trans Fat 0g', '', false, 24],
    ['Cholesterol 0mg', '0%', true, 0],
    ['Sodium 160mg', '7%', true, 0],
    ['Total Carbohydrate 37g', '13%', true, 0],
    ['Dietary Fiber 4g', '14%', false, 24],
    ['Total Sugars 12g', '', false, 24],
    ['Protein 3g', '', true, 0],
  ];

  let y = 392;
  for (const [text, dv, bold, indent] of items) {
    ctx.font = bold ? 'bold 26px Arial, Helvetica, sans-serif' : '25px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#111111';
    ctx.fillText(text, 70 + indent, y);
    if (dv) {
      ctx.font = 'bold 25px Arial, Helvetica, sans-serif';
      ctx.fillText(dv, 535, y);
    }
    ctx.fillStyle = '#888888';
    ctx.fillRect(66, y + 12, 528, 1.5);
    y += 38;
  }

  return {
    canvas,
    name: 'Sample: Whole Grain Cereal (US label)',
  };
}

function renderRoundLidLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 760;
  const ctx = canvas.getContext('2d');

  // Dark tabletop surrounding a round sticker (tests center-weighted contrast + circular label!)
  ctx.fillStyle = '#2d2621';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Circular white sticker
  ctx.beginPath();
  ctx.arc(380, 380, 315, 0, Math.PI * 2);
  ctx.fillStyle = '#fbfaf6';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#242220';
  ctx.stroke();

  ctx.fillStyle = '#141414';
  ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
  ctx.fillText('Nutrition Facts', 245, 195);

  ctx.fillRect(140, 214, 480, 4);

  ctx.font = '23px Arial, Helvetica, sans-serif';
  ctx.fillText('Servings: about 8, Serv. size: 2 Tbsp (28g),', 142, 256);
  ctx.font = 'bold 24px Arial, Helvetica, sans-serif';
  ctx.fillText('Amount per serving: Calories 140,', 142, 298);
  ctx.fillText('Total Fat 12g (15% DV), Sat. Fat 2g (10% DV),', 118, 342);
  ctx.font = '23px Arial, Helvetica, sans-serif';
  ctx.fillText('Trans Fat 0g, Cholest. 0mg (0% DV),', 155, 386);
  ctx.fillText('Sodium 150mg (7% DV), Total Carb. 5g (2% DV),', 120, 428);
  ctx.fillText('Fiber 2g (7% DV), Total Sugars 1g, Protein 4g.', 130, 470);

  ctx.fillRect(150, 502, 460, 2);
  ctx.font = '20px Arial, Helvetica, sans-serif';
  ctx.fillStyle = '#444444';
  ctx.fillText('Net Wt. 8 oz (227g)', 288, 548);

  return {
    canvas,
    name: 'Sample: Hummus Tub (Round lid)',
  };
}
