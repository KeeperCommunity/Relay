import db from "../db";

export const createAdvisor = async (data) => {
  const {
    title,
    country,
    description,
    image,
    link,
    expertise,
    duration,
    experience,
    timezone,
    languages,
  } = data;
  const advisorModel = db.getAdvisorModel();
  const newAdvisor = new advisorModel({
    title,
    country,
    description,
    image,
    link,
    expertise,
    duration,
    experience,
    timezone,
    languages,
  });
  await newAdvisor.save();
  return { created: true };
};

export const getAdvisors = async () => {
  const advisorModel = db.getAdvisorModel();
  const advisors = await advisorModel
    .find({ isActive: true })
    .select("-_id -__v -isActive -updatedAt -createdAt");
  return advisors;
};
